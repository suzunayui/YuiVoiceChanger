//! Moved from electron/system-monitor.cjs. Whole-PC load, read in this process so measuring
//! never competes with the audio process.

use crate::runtime;
use crate::util::local_now;
use serde_json::{json, Map, Value};
use std::path::Path;
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::Duration;
use sysinfo::System;

const INTERVAL: Duration = Duration::from_secs(10);
const GPU_FULL: f64 = 90.0;
const VRAM_FULL: f64 = 0.9;
const CPU_FULL: f64 = 90.0;
const CORE_FULL: f64 = 95.0;
const RAM_LOW: f64 = 0.1;
const THERMAL_MASK: u64 = 0x20 | 0x40;
const GPU_QUERY: &str = "--query-gpu=name,utilization.gpu,utilization.encoder,memory.used,memory.total,temperature.gpu,clocks_throttle_reasons.active";
const GIB: f64 = 1024.0 * 1024.0 * 1024.0;

#[derive(Clone, Debug, PartialEq)]
pub struct Gpu {
    pub name: String,
    pub util: f64,
    pub encoder: Option<f64>,
    pub vram_used_mb: Option<f64>,
    pub vram_total_mb: Option<f64>,
    pub temperature: Option<f64>,
    pub thermal_limit: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Cpu {
    pub total: f64,
    pub busiest: f64,
}

#[derive(Clone, Debug)]
pub struct Sample {
    pub cpu: Cpu,
    pub ram_free_ratio: f64,
    pub ram_free_gb: f64,
    pub ram_total_gb: f64,
    pub gpu: Option<Gpu>,
}

fn message(kind: &str) -> &'static str {
    match kind {
        "ok" => "問題は見つかりませんでした。",
        "other" => "変換は遅れていますが、CPU・メモリ・GPUには余裕があります。PCの負荷以外の原因かもしれません。",
        "gpu" => "GPUの処理が足りていません。OBSやカラオケなど、GPUを使うアプリを軽くすると改善するかもしれません。",
        "vram" => "GPUメモリが足りていません。GPUを使うアプリを閉じると改善するかもしれません。",
        "thermal" => "GPUの温度が高く、速度が制限されています。PCの冷却を確認してください。",
        "cpu" => "CPUが足りていません。同時に動かしているアプリを減らすと改善するかもしれません。",
        "memory" => "メモリの空きが少なくなっています。使っていないアプリを閉じてください。",
        _ => "",
    }
}

fn number(text: &str) -> Option<f64> {
    let digits: String = text.chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
    digits.parse().ok()
}

fn parse_line(line: &str) -> Option<Gpu> {
    let parts: Vec<&str> = line.split(',').map(str::trim).collect();
    let [name, util, encoder, used, total, temperature, reasons, ..] = parts.as_slice() else { return None };
    if name.is_empty() {
        return None;
    }
    let reasons = u64::from_str_radix(reasons.trim_start_matches("0x"), 16).unwrap_or(0);
    Some(Gpu {
        name: name.to_string(),
        util: number(util)?,
        encoder: number(encoder),
        vram_used_mb: number(used),
        vram_total_mb: number(total),
        temperature: number(temperature),
        thermal_limit: reasons & THERMAL_MASK != 0,
    })
}

/// The busiest GPU is the one that matters.
pub fn parse_nvidia_smi(text: &str) -> Option<Gpu> {
    text.lines().filter_map(parse_line).fold(None, |busiest: Option<Gpu>, gpu| match busiest {
        Some(current) if current.util >= gpu.util => Some(current),
        _ => Some(gpu),
    })
}

/// CPU and GPU only count as short when audio actually fell behind: busy but keeping up is fine.
pub fn judge(sample: &Sample, behind: bool) -> Vec<&'static str> {
    let mut kinds = Vec::new();
    if behind {
        if let Some(gpu) = &sample.gpu {
            if gpu.util >= GPU_FULL {
                kinds.push("gpu");
            }
            if let (Some(used), Some(total)) = (gpu.vram_used_mb, gpu.vram_total_mb) {
                if total > 0.0 && used / total >= VRAM_FULL {
                    kinds.push("vram");
                }
            }
            if gpu.thermal_limit {
                kinds.push("thermal");
            }
        }
        if sample.cpu.total >= CPU_FULL || sample.cpu.busiest >= CORE_FULL {
            kinds.push("cpu");
        }
    }
    if sample.ram_free_ratio < RAM_LOW {
        kinds.push("memory");
    }
    if kinds.is_empty() {
        kinds.push(if behind { "other" } else { "ok" });
    }
    kinds
}

fn shown(value: Option<f64>) -> String {
    value.map_or("null".to_string(), |value| value.to_string())
}

pub fn format_log_line(stamp: &str, sample: &Sample, behind: bool, kinds: &[&str]) -> String {
    let mut parts = vec![
        format!("cpu={:.0}%", sample.cpu.total.round()),
        format!("busiest_core={:.0}%", sample.cpu.busiest.round()),
        format!("ram_free_gb={:.1}/{:.1}", sample.ram_free_gb, sample.ram_total_gb),
    ];
    match &sample.gpu {
        Some(gpu) => {
            parts.push(format!("gpu={}%", gpu.util));
            parts.push(format!("encoder={}%", shown(gpu.encoder)));
            parts.push(format!("vram_mb={}/{}", shown(gpu.vram_used_mb), shown(gpu.vram_total_mb)));
            parts.push(format!("gpu_temp={}", shown(gpu.temperature)));
            parts.push(format!("thermal_limit={}", gpu.thermal_limit));
        }
        None => parts.push("gpu=unavailable".to_string()),
    }
    format!("{stamp} System: {} behind={behind} verdict={}", parts.join(" "), kinds.join("+"))
}

fn sample_json(sample: &Sample) -> Value {
    json!({
        "cpu": {"total": sample.cpu.total, "busiest": sample.cpu.busiest},
        "ramFreeRatio": sample.ram_free_ratio,
        "ramFreeGb": sample.ram_free_gb,
        "ramTotalGb": sample.ram_total_gb,
        "gpu": sample.gpu.as_ref().map(|gpu| json!({
            "name": gpu.name, "util": gpu.util, "encoder": gpu.encoder, "vramUsedMb": gpu.vram_used_mb,
            "vramTotalMb": gpu.vram_total_mb, "temperature": gpu.temperature, "thermalLimit": gpu.thermal_limit,
        })),
    })
}

/// Where the numbers come from.
pub trait Readers: Send {
    /// Starts a new measuring period for the CPU figures.
    fn reset(&mut self);
    fn gpu(&mut self) -> Option<Gpu>;
    fn cpu(&mut self) -> Cpu;
    /// Available and total memory in bytes.
    fn memory(&mut self) -> (u64, u64);
}

// None if the PC refused to say; the screen then just shows nothing is short.
struct PcReaders {
    system: Option<System>,
}

impl Readers for PcReaders {
    fn reset(&mut self) {
        if let Some(system) = &mut self.system {
            system.refresh_cpu_usage();
        }
    }

    fn gpu(&mut self) -> Option<Gpu> {
        let args = [GPU_QUERY.to_string(), "--format=csv,noheader".to_string()];
        let options = runtime::RunOptions { timeout: Duration::from_secs(3), ..runtime::RunOptions::default() };
        parse_nvidia_smi(&runtime::run(Path::new("nvidia-smi"), &args, options).ok()?)
    }

    fn cpu(&mut self) -> Cpu {
        let Some(system) = &mut self.system else { return Cpu { total: 0.0, busiest: 0.0 } };
        system.refresh_cpu_usage();
        let busiest = system.cpus().iter().map(|cpu| f64::from(cpu.usage())).fold(0.0, f64::max);
        Cpu { total: f64::from(system.global_cpu_usage()), busiest }
    }

    fn memory(&mut self) -> (u64, u64) {
        let Some(system) = &mut self.system else { return (0, 0) };
        system.refresh_memory();
        (system.available_memory(), system.total_memory())
    }
}

#[derive(Default)]
struct Period {
    active: bool,
    run: u64,
    seen: i64,
    latest: i64,
    found: Map<String, Value>,
    timer: Option<Sender<()>>,
}

type Publish = Arc<dyn Fn(Value) + Send + Sync>;
type WriteLog = Arc<dyn Fn(&str) + Send + Sync>;

pub struct SystemMonitor {
    period: Mutex<Period>,
    readers: Mutex<Box<dyn Readers>>,
    publish: Publish,
    write_log: WriteLog,
    interval: Duration,
}

fn counter(metrics: &Value, key: &str) -> i64 {
    metrics[key].as_i64().unwrap_or(0)
}

impl SystemMonitor {
    pub fn new(publish: Publish, write_log: WriteLog) -> Arc<Self> {
        Self::with_readers(Box::new(PcReaders { system: System::new().ok() }), publish, write_log, INTERVAL)
    }

    pub fn with_readers(readers: Box<dyn Readers>, publish: Publish, write_log: WriteLog, interval: Duration) -> Arc<Self> {
        Arc::new(Self { period: Mutex::new(Period::default()), readers: Mutex::new(readers), publish, write_log, interval })
    }

    fn period(&self) -> MutexGuard<'_, Period> {
        self.period.lock().unwrap()
    }

    pub fn start(self: &Arc<Self>) {
        self.stop();
        self.readers.lock().unwrap().reset();
        let (timer, stopped) = mpsc::channel();
        {
            let mut period = self.period();
            let run = period.run + 1;
            *period = Period { active: true, run, timer: Some(timer), ..Period::default() };
        }
        let this = Arc::downgrade(self);
        let interval = self.interval;
        thread::spawn(move || {
            // Dropping the sender in stop() ends this at once.
            while let Err(RecvTimeoutError::Timeout) = stopped.recv_timeout(interval) {
                let Some(monitor) = this.upgrade() else { return };
                monitor.sample();
            }
        });
    }

    pub fn stop(&self) {
        let mut period = self.period();
        period.active = false;
        period.timer = None;
    }

    pub fn observe(&self, metrics: &Value) {
        self.period().latest = counter(metrics, "late_blocks") + counter(metrics, "dropped") + counter(metrics, "skipped_blocks");
    }

    pub fn sample(&self) {
        let run = {
            let period = self.period();
            if !period.active {
                return;
            }
            period.run
        };
        let (gpu, cpu, (free, total)) = {
            let mut readers = self.readers.lock().unwrap();
            (readers.gpu(), readers.cpu(), readers.memory())
        };
        let (sample, behind, kinds, found) = {
            let mut period = self.period();
            // Sampling that finishes after stop, or after a restart, must not report.
            if !period.active || period.run != run {
                return;
            }
            let behind = period.latest > period.seen;
            period.seen = period.latest;
            let sample = Sample {
                cpu,
                ram_free_ratio: if total > 0 { free as f64 / total as f64 } else { 1.0 },
                ram_free_gb: free as f64 / GIB,
                ram_total_gb: total as f64 / GIB,
                gpu,
            };
            let kinds = judge(&sample, behind);
            for kind in kinds.iter().filter(|kind| **kind != "ok") {
                let count = period.found.get(*kind).and_then(Value::as_u64).unwrap_or(0);
                period.found.insert(kind.to_string(), json!(count + 1));
            }
            (sample, behind, kinds, period.found.clone())
        };
        (self.write_log)(&format_log_line(&stamp(), &sample, behind, &kinds));
        let verdicts: Vec<Value> = kinds.iter().map(|kind| json!({"kind": kind, "message": message(kind)})).collect();
        let summary: Vec<Value> = found.iter().map(|(kind, count)| json!({"kind": kind, "count": count, "message": message(kind)})).collect();
        (self.publish)(json!({"type": "system-status", "sample": sample_json(&sample), "behind": behind, "verdicts": verdicts, "found": found, "summary": summary}));
    }
}

fn stamp() -> String {
    let now = local_now();
    format!("{}-{:02}-{:02} {:02}:{:02}:{:02}", now.year, now.month, now.day, now.hour, now.minute, now.second)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn gpu() -> Gpu {
        Gpu { name: "RTX".to_string(), util: 40.0, encoder: Some(0.0), vram_used_mb: Some(1000.0), vram_total_mb: Some(8000.0), temperature: Some(50.0), thermal_limit: false }
    }

    fn roomy() -> Sample {
        Sample { cpu: Cpu { total: 30.0, busiest: 50.0 }, ram_free_ratio: 0.5, ram_free_gb: 8.0, ram_total_gb: 16.0, gpu: Some(gpu()) }
    }

    #[test]
    fn reads_nvidia_smi() {
        let parsed = parse_nvidia_smi("NVIDIA GeForce RTX 3060 Ti, 97 %, 12 %, 7000 MiB, 8192 MiB, 71, 0x0000000000000400\n").unwrap();
        assert_eq!(parsed, Gpu { name: "NVIDIA GeForce RTX 3060 Ti".to_string(), util: 97.0, encoder: Some(12.0), vram_used_mb: Some(7000.0), vram_total_mb: Some(8192.0), temperature: Some(71.0), thermal_limit: false });
        assert!(parse_nvidia_smi("A, 1 %, 0 %, 1 MiB, 10 MiB, 40, 0x0000000000000040\n").unwrap().thermal_limit, "hardware thermal slowdown");
        assert!(parse_nvidia_smi("A, 1 %, 0 %, 1 MiB, 10 MiB, 40, 0x0000000000000020\n").unwrap().thermal_limit, "software thermal slowdown");
        assert_eq!(parse_nvidia_smi("A, 1 %, [N/A], 1 MiB, 10 MiB, [N/A], [N/A]\n").unwrap().encoder, None);
        assert_eq!(parse_nvidia_smi("A, 5 %, 0 %, 1 MiB, 10 MiB, 40, 0x0\nB, 90 %, 0 %, 2 MiB, 10 MiB, 40, 0x0\n").unwrap().name, "B", "the busiest GPU");
        assert_eq!(parse_nvidia_smi(""), None);
        assert_eq!(parse_nvidia_smi("Failed to initialize NVML: Driver Not Loaded\n"), None);
    }

    #[test]
    fn judges_only_real_slowdowns() {
        let with_gpu = |change: fn(&mut Gpu)| {
            let mut sample = roomy();
            change(sample.gpu.as_mut().unwrap());
            sample
        };
        assert_eq!(judge(&roomy(), false), ["ok"]);
        assert_eq!(judge(&roomy(), true), ["other"]);
        assert_eq!(judge(&with_gpu(|gpu| gpu.util = 97.0), true), ["gpu"]);
        assert_eq!(judge(&with_gpu(|gpu| gpu.util = 97.0), false), ["ok"], "a busy GPU that keeps up is fine");
        assert_eq!(judge(&with_gpu(|gpu| gpu.vram_used_mb = Some(7600.0)), true), ["vram"]);
        assert_eq!(judge(&with_gpu(|gpu| gpu.thermal_limit = true), true), ["thermal"]);
        assert_eq!(judge(&Sample { cpu: Cpu { total: 95.0, busiest: 100.0 }, ..roomy() }, true), ["cpu"]);
        assert_eq!(judge(&Sample { cpu: Cpu { total: 40.0, busiest: 100.0 }, ..roomy() }, true), ["cpu"], "one saturated core can hold conversion back");
        assert_eq!(judge(&Sample { ram_free_ratio: 0.05, ..roomy() }, false), ["memory"], "worth reporting before audio suffers");
        assert_eq!(judge(&Sample { ram_free_ratio: 0.05, ..with_gpu(|gpu| gpu.util = 97.0) }, true), ["gpu", "memory"]);
        assert_eq!(judge(&Sample { gpu: None, ..roomy() }, false), ["ok"]);
        assert_eq!(judge(&Sample { gpu: None, ..roomy() }, true), ["other"]);
        for kind in ["ok", "other", "gpu", "vram", "thermal", "cpu", "memory"] {
            assert!(!message(kind).is_empty(), "{kind}");
        }
    }

    #[test]
    fn writes_the_same_log_line_as_the_electron_app() {
        let sample = Sample {
            cpu: Cpu { total: 75.4, busiest: 100.0 },
            ram_free_ratio: 0.25,
            ram_free_gb: 4.0,
            ram_total_gb: 16.0,
            gpu: Some(Gpu { util: 97.0, encoder: Some(12.0), vram_used_mb: Some(7000.0), vram_total_mb: Some(8192.0), temperature: Some(71.0), ..gpu() }),
        };
        assert_eq!(
            format_log_line("2026-11-07 20:00:00", &sample, true, &["gpu"]),
            "2026-11-07 20:00:00 System: cpu=75% busiest_core=100% ram_free_gb=4.0/16.0 gpu=97% encoder=12% vram_mb=7000/8192 gpu_temp=71 thermal_limit=false behind=true verdict=gpu"
        );
        assert!(format_log_line("t", &Sample { gpu: None, ..roomy() }, false, &["ok"]).ends_with("gpu=unavailable behind=false verdict=ok"));
    }

    struct FakeReaders;
    impl Readers for FakeReaders {
        fn reset(&mut self) {}
        fn gpu(&mut self) -> Option<Gpu> {
            Some(Gpu { util: 97.0, ..gpu() })
        }
        fn cpu(&mut self) -> Cpu {
            Cpu { total: 10.0, busiest: 20.0 }
        }
        fn memory(&mut self) -> (u64, u64) {
            (8 << 30, 16 << 30)
        }
    }

    struct Rig {
        monitor: Arc<SystemMonitor>,
        published: Arc<Mutex<Vec<Value>>>,
        logged: Arc<Mutex<Vec<String>>>,
    }

    fn rig(interval: Duration) -> Rig {
        let published = Arc::new(Mutex::new(Vec::new()));
        let logged = Arc::new(Mutex::new(Vec::new()));
        let (events, lines) = (published.clone(), logged.clone());
        let monitor = SystemMonitor::with_readers(
            Box::new(FakeReaders),
            Arc::new(move |event| events.lock().unwrap().push(event)),
            Arc::new(move |line: &str| lines.lock().unwrap().push(line.to_string())),
            interval,
        );
        Rig { monitor, published, logged }
    }

    impl Rig {
        fn last(&self) -> Value {
            self.published.lock().unwrap().last().unwrap().clone()
        }
    }

    #[test]
    fn behind_is_measured_against_the_previous_sample_and_each_conversion_starts_clean() {
        let rig = rig(Duration::from_secs(3600));
        let metrics = |late: i64, dropped: i64, skipped: i64| json!({"late_blocks": late, "dropped": dropped, "skipped_blocks": skipped});
        rig.monitor.start();
        rig.monitor.observe(&metrics(0, 0, 0));
        rig.monitor.sample();
        assert_eq!(rig.last()["verdicts"][0]["kind"], "ok");
        assert_eq!(rig.last()["behind"], false);
        assert_eq!(rig.last()["type"], "system-status");
        assert_eq!(rig.last()["sample"]["gpu"]["vramTotalMb"], 8000.0);
        assert_eq!(rig.last()["sample"]["ramFreeGb"], 8.0);

        rig.monitor.observe(&metrics(3, 0, 0));
        rig.monitor.sample();
        assert_eq!(rig.last()["verdicts"][0]["kind"], "gpu");
        assert_eq!(rig.last()["behind"], true);
        assert_eq!(rig.last()["found"], json!({"gpu": 1}));
        assert_eq!(rig.last()["summary"][0], json!({"kind": "gpu", "count": 1, "message": message("gpu")}));

        rig.monitor.sample();
        assert_eq!(rig.last()["behind"], false, "no new late blocks means it recovered");
        assert_eq!(rig.last()["found"], json!({"gpu": 1}), "what was found stays visible");

        rig.monitor.observe(&metrics(3, 1, 0));
        rig.monitor.sample();
        assert_eq!(rig.last()["found"], json!({"gpu": 2}));
        rig.monitor.observe(&metrics(3, 1, 2));
        rig.monitor.sample();
        assert_eq!(rig.last()["found"], json!({"gpu": 3}));
        let line = rig.logged.lock().unwrap().last().unwrap().clone();
        assert!(line.contains(" System: ") && line.ends_with("behind=true verdict=gpu"), "{line}");

        rig.monitor.stop();
        let count = rig.published.lock().unwrap().len();
        rig.monitor.sample();
        assert_eq!(rig.published.lock().unwrap().len(), count, "nothing is reported after stop");

        rig.monitor.start();
        rig.monitor.observe(&metrics(0, 0, 0));
        rig.monitor.sample();
        assert_eq!(rig.last()["found"], json!({}), "a new conversion starts clean");
        rig.monitor.stop();
    }

    #[test]
    fn the_timer_samples_until_stopped() {
        let rig = rig(Duration::from_millis(5));
        rig.monitor.start();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while rig.published.lock().unwrap().len() < 2 && std::time::Instant::now() < deadline {
            thread::sleep(Duration::from_millis(5));
        }
        assert!(rig.published.lock().unwrap().len() >= 2);
        rig.monitor.stop();
        thread::sleep(Duration::from_millis(30));
        let count = rig.published.lock().unwrap().len();
        thread::sleep(Duration::from_millis(30));
        assert_eq!(rig.published.lock().unwrap().len(), count);
    }

    #[test]
    fn a_pc_without_nvidia_still_reports_cpu_and_memory() {
        struct NoGpu(AtomicU64);
        impl Readers for NoGpu {
            fn reset(&mut self) {}
            fn gpu(&mut self) -> Option<Gpu> {
                self.0.fetch_add(1, Ordering::SeqCst);
                None
            }
            fn cpu(&mut self) -> Cpu {
                Cpu { total: 1.0, busiest: 2.0 }
            }
            fn memory(&mut self) -> (u64, u64) {
                (1, 2)
            }
        }
        let published = Arc::new(Mutex::new(Vec::new()));
        let events = published.clone();
        let monitor = SystemMonitor::with_readers(Box::new(NoGpu(AtomicU64::new(0))), Arc::new(move |event| events.lock().unwrap().push(event)), Arc::new(|_: &str| {}), Duration::from_secs(3600));
        monitor.start();
        monitor.sample();
        monitor.stop();
        assert_eq!(published.lock().unwrap()[0]["sample"]["gpu"], Value::Null);
    }
}

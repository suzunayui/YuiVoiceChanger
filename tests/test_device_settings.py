import unittest
from unittest.mock import Mock
from backend.realtime import audio_settings, resolve_devices


class DeviceSettingsTests(unittest.TestCase):
    def test_saved_names_override_renumbered_ids_and_skip_other_hosts(self):
        available = [dict(id=1,name='Mic',host='MME',inputs=2,outputs=0),
                     dict(id=30,name='Mic',host='Windows WASAPI',inputs=2,outputs=0),
                     dict(id=25,name='CABLE',host='Windows WASAPI',inputs=0,outputs=2)]
        self.assertEqual(resolve_devices(dict(input=1,output=9,input_name='Mic',output_name='CABLE'), available), (30,25))
        with self.assertRaisesRegex(ValueError, '選び直して'):
            resolve_devices(dict(input=1,output=9,input_name='Gone',output_name='CABLE'), available)

    def test_core_audio_uses_conversion_without_changing_hardware_settings(self):
        sd = Mock()
        sd.query_hostapis.return_value = [{'name': 'Core Audio'}]
        sd.query_devices.return_value = {'hostapi': 0, 'name': 'Mac microphone'}
        audio_settings(sd, 0, 1, 2)
        self.assertEqual(sd.CoreAudioSettings.call_count, 2)
        sd.CoreAudioSettings.assert_called_with(change_device_parameters=False,
                                               fail_if_conversion_required=False,
                                               conversion_quality='max')

    def test_input_and_output_get_conversion_but_other_hosts_do_not(self):
        sd = Mock()
        sd.query_hostapis.return_value = [{'name': 'Windows WASAPI'}, {'name': 'ASIO'}]
        sd.query_devices.side_effect = lambda device: {'hostapi': device, 'name': 'test'}
        extra = audio_settings(sd, 0, 1, 2)
        sd.WasapiSettings.assert_called_once_with(exclusive=False, auto_convert=True)
        self.assertIsNone(extra[1])
        self.assertEqual(sd.check_input_settings.call_args.kwargs['extra_settings'], extra[0])
        self.assertIsNone(sd.check_output_settings.call_args.kwargs['extra_settings'])

    def test_failure_identifies_the_device(self):
        sd = Mock()
        sd.PortAudioError = ValueError
        sd.query_hostapis.return_value = [{'name': 'Windows WASAPI'}]
        sd.query_devices.return_value = {'hostapi': 0, 'name': 'USB microphone'}
        sd.check_input_settings.side_effect = ValueError('Invalid sample rate')
        with self.assertRaisesRegex(RuntimeError, 'USB microphone'):
            audio_settings(sd, 0, 1, 2)
        sd.check_output_settings.assert_not_called()

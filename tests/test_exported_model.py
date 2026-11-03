import tempfile
from pathlib import Path
import unittest
import numpy as np
import torch
from backend import beatrice_model as m
from backend.exported_model import Reader,freeze_export_weights,manifest_path


class ExportTests(unittest.TestCase):
    def test_exported_small_output_scales_are_not_normalized_away(self):
        layer=m.WSLinear(4,1,bias=True)
        layer.weight.data.fill_(.001)
        freeze_export_weights(layer)
        torch.testing.assert_close(layer(torch.ones(1,4)),torch.tensor([[.004]]))

    def test_truncated_and_nonfinite_exports_fail_clearly(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'weights.bin'
            path.write_bytes(np.array([1,2],dtype='<f2').tobytes())
            with self.assertRaisesRegex(ValueError,'不完全'):Reader(path).tensor((3,))
            path.write_bytes(np.array([np.inf],dtype='<f2').tobytes())
            with self.assertRaisesRegex(ValueError,'不正な値'):Reader(path).tensor((1,))

    def test_manifest_lists_missing_components_without_writing(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'voice.toml'
            path.write_text('[model]\nversion="2.0.0-rc.0"\n[voice.0]\nname="voice"\n',encoding='utf8')
            with self.assertRaisesRegex(ValueError,'phone_extractor.bin'):manifest_path(path)

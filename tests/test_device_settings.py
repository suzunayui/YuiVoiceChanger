import unittest
from unittest.mock import Mock
from backend.realtime import audio_settings


class DeviceSettingsTests(unittest.TestCase):
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

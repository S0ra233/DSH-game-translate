"""No QApplication / GUI is created: test Qt IPC dispatch with an injected chooser."""
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("native_panel", Path(__file__).parents[1] / "native" / "panel.py")
panel = importlib.util.module_from_spec(spec)
spec.loader.exec_module(panel)


class NativeProtocolTests(unittest.TestCase):
    class Window(panel.QObject):
        def close(self):
            pass
        def shutdown(self):
            self.shut_down = True
        def set_surface(self, glass, frost=65):
            self.glass = glass
            self.frost = frost
        def preview_frost(self, value):
            self.frost = value

    def test_directory_uses_native_chooser_instead_of_accepting_a_web_path(self):
        output = []
        actions = []
        window = self.Window()
        bridge = panel.Bridge(window, choose_directory=lambda action: actions.append(action) or "D:/ChosenGame", output=output.append)
        events = []
        bridge.hostEvent.connect(events.append)
        bridge.incoming.emit(json.dumps({"kind": "bootstrap", "sessionId": "root-test", "appearance": {"surface": "glass"}}))
        self.assertEqual(events, ["bootstrap"])
        self.assertTrue(window.glass)
        self.assertEqual(window.frost, 65)
        self.assertTrue(callable(bridge.event))  # QObject's event dispatch must remain intact.
        bridge.invoke("1", "pick-game", json.dumps({"path": "C:/forged"}))
        self.assertEqual(actions, ["pick-game"])
        self.assertEqual(output, [{"kind": "directory-picked", "id": "1", "action": "pick-game", "path": "D:/ChosenGame"}])
        bridge.invoke("2", "pick-output", "{}")
        self.assertEqual(output[-1]["action"], "pick-output")

    def test_cancel_and_unsupported_requests_do_not_authorize_a_directory(self):
        output = []
        window = self.Window()
        bridge = panel.Bridge(window, choose_directory=lambda _: None, output=output.append)
        bridge.invoke("1", "pick-game", "{}")
        self.assertIsNone(output[0]["path"])
        bridge.invoke("2", "execute-shell", "{}")
        self.assertEqual(len(output), 1)
        with self.assertRaises(ValueError):
            panel.parse_call("3", "snapshot", "[]")

    def test_frost_is_applied_live_and_never_loses_its_protective_backing(self):
        window = self.Window()
        bridge = panel.Bridge(window, output=lambda _: None)
        bridge.invoke("1", "native-appearance", json.dumps({"preferences": {"surface": "glass", "frost": 80}}))
        self.assertEqual((window.glass, window.frost), (True, 80))
        self.assertEqual(panel.frost_strength(float('nan')), 65)
        self.assertEqual(panel.frost_strength(-999), 35)
        self.assertEqual(panel.frost_strength(999), 100)
        self.assertEqual(panel.frost_strength(True), 65)
        self.assertEqual(panel.glass_alpha(35), panel.MATERIAL["nativeGlassAlphaMin"])
        self.assertEqual(panel.glass_alpha(100), panel.MATERIAL["nativeGlassAlphaMax"])
        self.assertGreaterEqual(panel.glass_alpha(65), 242)
        self.assertGreaterEqual(panel.glass_alpha(100) - panel.glass_alpha(35), 45)
        self.assertEqual(panel.glass_alpha(None), panel.glass_alpha(65))
        self.assertEqual(panel.MATERIAL["white"], [255, 255, 255])
        bridge.previewFrost(48.25)
        self.assertEqual(window.frost, 48.25)

    def test_dragging_frost_updates_chrome_but_does_not_invalidate_webengine_or_reset_blur(self):
        class Effects:
            def __init__(self):
                self.calls = []
            def surface(self, glass):
                self.calls.append(glass)
        class Window:
            glass = False
            frost = 65
            effects = Effects()
            regions = []
            class View:
                def mapTo(self, _parent, _point):
                    return panel.QPoint(1, 39)
                def size(self):
                    return panel.QRect(0, 0, 1118, 760).size()
            view = View()
            preview_frost = panel.Panel.preview_frost
            update_chrome = panel.Panel.update_chrome
            def rect(self):
                return panel.QRect(0, 0, 1120, 800)
            def update(self, region=None):
                if not isinstance(region, panel.QRegion):
                    raise AssertionError('A whole-window update would reintroduce flicker')
                self.regions.append(region)
        window = Window()
        panel.Panel.set_surface(window, True, 65)
        for frost in list(range(35, 101)) + list(range(100, 34, -1)):
            panel.Panel.set_surface(window, True, frost)
        self.assertEqual(window.effects.calls, [True])
        self.assertGreater(len(window.regions), 1)
        for region in window.regions:
            self.assertTrue(region.intersected(panel.QRegion(panel.QRect(1, 39, 1118, 760))).isEmpty())
            self.assertTrue(region.contains(panel.QPoint(12, 20)))
        old_frost = window.frost
        panel.Panel.preview_frost(window, float('nan'))
        self.assertEqual(window.frost, old_frost)
        panel.Panel.set_surface(window, False, 65)
        self.assertEqual(window.effects.calls, [True, False])

    def test_actual_window_outline_rounds_all_corners_and_maximize_restores_rectangle(self):
        for width, height in [(640, 420), (1120, 800), (1600, 1000)]:
            rounded = panel.window_outline(width, height)
            for x, y in [(1, 1), (width-1, 1), (1, height-1), (width-1, height-1)]:
                self.assertFalse(rounded.contains(panel.QPoint(x, y)))
                self.assertTrue(panel.window_outline(width, height, True).contains(panel.QPoint(x, y)))
            region = panel.QRegion(rounded.toFillPolygon().toPolygon())
            self.assertFalse(region.contains(panel.QPoint(1, 1)))
            self.assertTrue(region.contains(panel.QPoint(24, 1)))
            self.assertTrue(rounded.contains(panel.QPoint(width//2, height//2)))

    def test_close_retains_a_frozen_page_and_host_shutdown_is_still_final(self):
        self.assertGreaterEqual(panel.Panel.staticMetaObject.indexOfSlot('shutdown()'), 0)
        events, output = [], []
        class Page:
            def setVisible(self, value):
                events.append(('visible', value))
            def setLifecycleState(self, value):
                events.append(('lifecycle', value))
        class Window:
            active_picker = None
            shutting_down = False
            client_ready = True
            page = Page()
            suspend_page = panel.Panel.suspend_page
            bridge = type('Bridge', (), {'hostEvent': type('Signal', (), {'emit': lambda _, value: events.append(('event', value))})()})()
            def hide(self):
                events.append(('hide', True))
            def close(self):
                events.append(('final-close', self.shutting_down))
        class Event:
            def ignore(self):
                events.append(('ignored', True))
        window = Window()
        with patch.object(panel, 'send', side_effect=output.append):
            panel.Panel.closeEvent(window, Event())
        self.assertIn(('event', 'window-hidden'), events)
        self.assertIn(('visible', False), events)
        self.assertIn(('lifecycle', panel.QWebEnginePage.LifecycleState.Frozen), events)
        self.assertEqual(output, [{'kind': 'hidden'}])
        panel.Panel.shutdown(window)
        self.assertIn(('final-close', True), events)

    def test_hidden_page_can_finish_starting_before_it_is_frozen(self):
        states = []
        class Page:
            def setVisible(self, value):
                states.append(value)
            def setLifecycleState(self, value):
                states.append(value)
        window = type('Window', (), {'client_ready': False, 'page': Page()})()
        panel.Panel.suspend_page(window)
        self.assertEqual(states, [False])


if __name__ == "__main__":
    unittest.main()

import React, { useEffect, useRef, useImperativeHandle, forwardRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  registerBlinkitInjector,
  unregisterBlinkitInjector,
  handleBlinkitBridgeMessage,
  takeBlinkitBridgeCookies,
  registerBlinkitBridgeReload,
  unregisterBlinkitBridgeReload,
} from '../services/blinkitBridge';

const BRIDGE_SCRIPT_B64 = 'CihmdW5jdGlvbigpIHsKICB0cnkgewogIGlmICh3aW5kb3cuX19ibEJyaWRnZUluc3RhbGxlZCkgcmV0dXJuOwogIHdpbmRvdy5fX2JsQnJpZGdlSW5zdGFsbGVkID0gdHJ1ZTsKICB3aW5kb3cuX19ibFNjcmlwdFJhbiA9IHRydWU7CgogIHdpbmRvdy5fX2JsU3RvcmVkQWRkcklkID0gbnVsbDsKICB3aW5kb3cuX19ibFN0b3JlZExhdCA9IG51bGw7CiAgd2luZG93Ll9fYmxTdG9yZWRMbmcgPSBudWxsOwogIHdpbmRvdy5fX2JsQWRkckFwaUZldGNoZWQgPSBmYWxzZTsKCiAgd2luZG93Ll9fYmxBcHBseUNvb2tpZXMgPSBmdW5jdGlvbihjb29raWVTdHIpIHsKICAgIHRyeSB7CiAgICAgIHZhciBwYXJ0cyA9IFN0cmluZyhjb29raWVTdHIgfHwgJycpLnNwbGl0KC87XFxzKi8pOwogICAgICBmb3IgKHZhciBpID0gMDsgaSA8IHBhcnRzLmxlbmd0aDsgaSsrKSB7CiAgICAgICAgaWYgKCFwYXJ0c1tpXSkgY29udGludWU7CiAgICAgICAgdmFyIGVxID0gcGFydHNbaV0uaW5kZXhPZignPScpOwogICAgICAgIGlmIChlcSA8PSAwKSBjb250aW51ZTsKICAgICAgICBkb2N1bWVudC5jb29raWUgPSBwYXJ0c1tpXSArICc7IHBhdGg9LzsgZG9tYWluPS5ibGlua2l0LmNvbTsgc2VjdXJlOyBTYW1lU2l0ZT1Ob25lJzsKICAgICAgfQogICAgfSBjYXRjaCAoZSkge30KICB9OwoKICB3aW5kb3cuX19ibEdldEFjY2Vzc1Rva2VuID0gZnVuY3Rpb24oKSB7CiAgICB0cnkgewogICAgICB2YXIgYXV0aFJhdyA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKCdhdXRoJyk7CiAgICAgIGlmIChhdXRoUmF3KSB7IHZhciBhbyA9IEpTT04ucGFyc2UoYXV0aFJhdyk7IGlmIChhby5hY2Nlc3NUb2tlbikgcmV0dXJuIGFvLmFjY2Vzc1Rva2VuOyB9CiAgICB9IGNhdGNoIChlKSB7fQogICAgdHJ5IHsKICAgICAgdmFyIGNvb2tpZXMgPSBkb2N1bWVudC5jb29raWUuc3BsaXQoJzsnKTsKICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBjb29raWVzLmxlbmd0aDsgaSsrKSB7CiAgICAgICAgdmFyIGMgPSBjb29raWVzW2ldLnRyaW0oKTsKICAgICAgICBpZiAoYy5pbmRleE9mKCdncl8xX2FjY2Vzc1Rva2VuPScpID09PSAwKSB7CiAgICAgICAgICByZXR1cm4gZGVjb2RlVVJJQ29tcG9uZW50KGMuc3Vic3RyaW5nKCdncl8xX2FjY2Vzc1Rva2VuPScubGVuZ3RoKSk7CiAgICAgICAgfQogICAgICB9CiAgICB9IGNhdGNoIChlMikge30KICAgIHJldHVybiAnJzsKICB9OwoKICB3aW5kb3cuX19ibFNldERlbGl2ZXJ5Q29udGV4dCA9IGZ1bmN0aW9uKGFkZHJJZCwgbGF0LCBsbmcpIHsKICAgIHRyeSB7CiAgICAgIGlmICghbGF0IHx8ICFsbmcpIHsKICAgICAgICB0cnkgewogICAgICAgICAgdmFyIGxzTGF0ID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oJ3NlbGVjdGVkX2xhdCcpOwogICAgICAgICAgdmFyIGxzTG5nID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oJ3NlbGVjdGVkX2xuZycpOwogICAgICAgICAgaWYgKGxzTGF0ICYmIGxzTG5nKSB7IGxhdCA9IGxhdCB8fCBsc0xhdDsgbG5nID0gbG5nIHx8IGxzTG5nOyB9CiAgICAgICAgfSBjYXRjaCAoZSkge30KICAgICAgfQogICAgICB3aW5kb3cuX19ibFN0b3JlZEFkZHJJZCA9IGFkZHJJZCB8fCBudWxsOwogICAgICB3aW5kb3cuX19ibFN0b3JlZExhdCA9IGxhdCB8fCBudWxsOwogICAgICB3aW5kb3cuX19ibFN0b3JlZExuZyA9IGxuZyB8fCBudWxsOwogICAgICBpZiAoYWRkcklkKSBsb2NhbFN0b3JhZ2Uuc2V0SXRlbSgnc2VsZWN0ZWRfYWRkcmVzc19pZCcsIFN0cmluZyhhZGRySWQpKTsKICAgICAgaWYgKGxhdCkgbG9jYWxTdG9yYWdlLnNldEl0ZW0oJ3NlbGVjdGVkX2xhdCcsIFN0cmluZyhsYXQpKTsKICAgICAgaWYgKGxuZykgbG9jYWxTdG9yYWdlLnNldEl0ZW0oJ3NlbGVjdGVkX2xuZycsIFN0cmluZyhsbmcpKTsKICAgICAgdHJ5IHsKICAgICAgICB2YXIgZXhpc3RpbmcgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbSgnYWRkcmVzc2VzX2RhdGEnKTsKICAgICAgICBpZiAoZXhpc3RpbmcgJiYgYWRkcklkKSB7CiAgICAgICAgICB2YXIgcGFyc2VkID0gSlNPTi5wYXJzZShleGlzdGluZyk7CiAgICAgICAgICBpZiAocGFyc2VkICYmIHBhcnNlZC5hZGRyZXNzZXMgJiYgQXJyYXkuaXNBcnJheShwYXJzZWQuYWRkcmVzc2VzLmFkZHJlc3Nlc19kYXRhKSkgewogICAgICAgICAgICB2YXIgbWF0Y2ggPSBwYXJzZWQuYWRkcmVzc2VzLmFkZHJlc3Nlc19kYXRhLmZpbmQoZnVuY3Rpb24oYSkgeyByZXR1cm4gU3RyaW5nKGEuaWQpID09PSBTdHJpbmcoYWRkcklkKTsgfSk7CiAgICAgICAgICAgIGlmIChtYXRjaCkgbG9jYWxTdG9yYWdlLnNldEl0ZW0oJ3NlbGVjdGVkX2FkZHJlc3NfaWQnLCBTdHJpbmcoYWRkcklkKSk7CiAgICAgICAgICB9CiAgICAgICAgfQogICAgICB9IGNhdGNoIChlMikge30KICAgICAgaWYgKGFkZHJJZCkgewogICAgICAgIHZhciBiTGF0ID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oJ3NlbGVjdGVkX2xhdCcpIHx8IGxhdCB8fCAnMTIuOTcxNic7CiAgICAgICAgdmFyIGJMbmcgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbSgnc2VsZWN0ZWRfbG5nJykgfHwgbG5nIHx8ICc3Ny41OTQ2JzsKICAgICAgICB2YXIgYWNjZXNzVG9rZW4gPSB3aW5kb3cuX19ibEdldEFjY2Vzc1Rva2VuKCk7CiAgICAgICAgdmFyIGRldmljZUlkID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oJ2RldmljZUlkJykgfHwgJyc7CiAgICAgICAgdmFyIGF1dGhLZXkgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbSgnYXV0aEtleScpIHx8ICcnOwogICAgICAgIHZhciBzZWxIID0geyAnQ29udGVudC1UeXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nLCAnQWNjZXB0JzogJ2FwcGxpY2F0aW9uL2pzb24nLCAnYWNjZXNzX3Rva2VuJzogYWNjZXNzVG9rZW4sICdhdXRoX2tleSc6IGF1dGhLZXksICdhcHBfY2xpZW50JzogJ2NvbnN1bWVyX3dlYicsICdsYXQnOiBiTGF0LCAnbG9uJzogYkxuZywgJ2RldmljZV9pZCc6IGRldmljZUlkLCAncGxhdGZvcm0nOiAnbW9iaWxlX3dlYicgfTsKICAgICAgICBmZXRjaCgnaHR0cHM6Ly9ibGlua2l0LmNvbS92Mi9hZGRyZXNzL3NlbGVjdCcsIHsgbWV0aG9kOiAnUE9TVCcsIGNyZWRlbnRpYWxzOiAnaW5jbHVkZScsIGhlYWRlcnM6IHNlbEgsIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgYWRkcmVzc19pZDogTnVtYmVyKGFkZHJJZCkgfSkgfSkudGhlbihmdW5jdGlvbigpIHt9KS5jYXRjaChmdW5jdGlvbigpIHt9KTsKICAgICAgICBmZXRjaCgnaHR0cHM6Ly9ibGlua2l0LmNvbS92MS9hZGRyZXNzL3NlbGVjdCcsIHsgbWV0aG9kOiAnUE9TVCcsIGNyZWRlbnRpYWxzOiAnaW5jbHVkZScsIGhlYWRlcnM6IHNlbEgsIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgaWQ6IE51bWJlcihhZGRySWQpIH0pIH0pLnRoZW4oZnVuY3Rpb24oKSB7fSkuY2F0Y2goZnVuY3Rpb24oKSB7fSk7CiAgICAgICAgZmV0Y2goJ2h0dHBzOi8vYmxpbmtpdC5jb20vdjEvYWRkcmVzc2VzL3NlbGVjdCcsIHsgbWV0aG9kOiAnUE9TVCcsIGNyZWRlbnRpYWxzOiAnaW5jbHVkZScsIGhlYWRlcnM6IHNlbEgsIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgYWRkcmVzc19pZDogTnVtYmVyKGFkZHJJZCkgfSkgfSkudGhlbihmdW5jdGlvbigpIHt9KS5jYXRjaChmdW5jdGlvbigpIHt9KTsKICAgICAgfQogICAgfSBjYXRjaCAoZSkge30KICB9OwoKICB3aW5kb3cuX19ibEhhbmRsZVJlcXVlc3QgPSBmdW5jdGlvbihpZCwgdXJsLCBtZXRob2QsIGJvZHksIGV4dHJhSGVhZGVyc0pzb24pIHsKICAgIHZhciBvcHRzID0gewogICAgICBtZXRob2Q6IG1ldGhvZCB8fCAnR0VUJywKICAgICAgY3JlZGVudGlhbHM6ICdpbmNsdWRlJywKICAgICAgaGVhZGVyczogeyAnQWNjZXB0JzogJ2FwcGxpY2F0aW9uL2pzb24sIHRleHQvcGxhaW4sICovKicgfQogICAgfTsKICAgIHRyeSB7CiAgICAgIHZhciBleHRyYSA9IEpTT04ucGFyc2UoZXh0cmFIZWFkZXJzSnNvbiB8fCAne30nKTsKICAgICAgZm9yICh2YXIgayBpbiBleHRyYSkgeyBpZiAoZXh0cmFba10pIG9wdHMuaGVhZGVyc1trXSA9IGV4dHJhW2tdOyB9CiAgICB9IGNhdGNoIChlMikge30KICAgIHRyeSB7CiAgICAgIHZhciBhayA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKCdhdXRoS2V5Jyk7CiAgICAgIGlmIChhayAmJiAhb3B0cy5oZWFkZXJzWydhdXRoX2tleSddKSBvcHRzLmhlYWRlcnNbJ2F1dGhfa2V5J10gPSBhazsKICAgIH0gY2F0Y2ggKGUzKSB7fQogICAgdHJ5IHsKICAgICAgaWYgKCFvcHRzLmhlYWRlcnNbJ2FjY2Vzc190b2tlbiddKSB7CiAgICAgICAgdmFyIGF0ID0gd2luZG93Ll9fYmxHZXRBY2Nlc3NUb2tlbiA/IHdpbmRvdy5fX2JsR2V0QWNjZXNzVG9rZW4oKSA6ICcnOwogICAgICAgIGlmIChhdCkgb3B0cy5oZWFkZXJzWydhY2Nlc3NfdG9rZW4nXSA9IGF0OwogICAgICB9CiAgICB9IGNhdGNoIChlMTIpIHt9CiAgICB0cnkgewogICAgICB2YXIgZHYgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbSgnZGV2aWNlSWQnKTsKICAgICAgaWYgKGR2KSB7CiAgICAgICAgaWYgKCFvcHRzLmhlYWRlcnNbJ0RldmljZUlEJ10pIG9wdHMuaGVhZGVyc1snRGV2aWNlSUQnXSA9IGR2OwogICAgICAgIGlmICghb3B0cy5oZWFkZXJzWydkZXZpY2VfaWQnXSkgb3B0cy5oZWFkZXJzWydkZXZpY2VfaWQnXSA9IGR2OwogICAgICAgIGlmICghb3B0cy5oZWFkZXJzWydkZXZpY2VpZCddKSBvcHRzLmhlYWRlcnNbJ2RldmljZWlkJ10gPSBkdjsKICAgICAgICBpZiAoIW9wdHMuaGVhZGVyc1sneC1kZXZpY2UtaWQnXSkgb3B0cy5oZWFkZXJzWyd4LWRldmljZS1pZCddID0gZHY7CiAgICAgIH0KICAgIH0gY2F0Y2ggKGUxMSkge30KICAgIGlmIChib2R5KSB7CiAgICAgIG9wdHMuaGVhZGVyc1snQ29udGVudC1UeXBlJ10gPSAnYXBwbGljYXRpb24vanNvbic7CiAgICAgIGlmICgvXC92NVwvY2FydHMvLnRlc3QodXJsKSAmJiBtZXRob2QgPT09ICdQT1NUJykgewogICAgICAgIHRyeSB7CiAgICAgICAgICB2YXIgYiA9IEpTT04ucGFyc2UoYm9keSk7CiAgICAgICAgICBpZiAoIWIuYWRkcmVzc19pZCAmJiB3aW5kb3cuX19ibFN0b3JlZEFkZHJJZCkgewogICAgICAgICAgICBiLmFkZHJlc3NfaWQgPSBOdW1iZXIod2luZG93Ll9fYmxTdG9yZWRBZGRySWQpOwogICAgICAgICAgICBib2R5ID0gSlNPTi5zdHJpbmdpZnkoYik7CiAgICAgICAgICB9CiAgICAgICAgfSBjYXRjaCAoZTQpIHt9CiAgICAgIH0KICAgICAgb3B0cy5ib2R5ID0gYm9keTsKICAgIH0KICAgIGZldGNoKHVybCwgb3B0cykudGhlbihmdW5jdGlvbihyZXMpIHsKICAgICAgcmV0dXJuIHJlcy50ZXh0KCkudGhlbihmdW5jdGlvbih0KSB7CiAgICAgICAgd2luZG93LlJlYWN0TmF0aXZlV2ViVmlldy5wb3N0TWVzc2FnZShKU09OLnN0cmluZ2lmeSh7CiAgICAgICAgICB0eXBlOiAnQkxfQVBJX1JFU1BPTlNFJywgaWQ6IGlkLCBzdGF0dXM6IHJlcy5zdGF0dXMsIHRleHQ6IFN0cmluZyh0KS5zbGljZSgwLCAxNTAwMDAwKQogICAgICAgIH0pKTsKICAgICAgfSk7CiAgICB9KS5jYXRjaChmdW5jdGlvbihlKSB7CiAgICAgIHdpbmRvdy5SZWFjdE5hdGl2ZVdlYlZpZXcucG9zdE1lc3NhZ2UoSlNPTi5zdHJpbmdpZnkoewogICAgICAgIHR5cGU6ICdCTF9BUElfUkVTUE9OU0UnLCBpZDogaWQsIHN0YXR1czogMCwgdGV4dDogU3RyaW5nKChlICYmIGUubWVzc2FnZSkgfHwgZSkKICAgICAgfSkpOwogICAgfSk7CiAgfTsKICB3aW5kb3cuUmVhY3ROYXRpdmVXZWJWaWV3LnBvc3RNZXNzYWdlKEpTT04uc3RyaW5naWZ5KHsgdHlwZTogJ0JMX0JSSURHRV9SRUFEWScgfSkpOwoKICAvLyBBdXRvLWZldGNoIGFkZHJlc3NlcyB2aWEgL3Y0L2FkZHJlc3Mgb24gZXZlcnkgYnJpZGdlIGxvYWQuCiAgLy8gSW4gQVBLIGJ1aWxkcywgbG9jYWxTdG9yYWdlIGlzbid0IHNoYXJlZCBiZXR3ZWVuIFdlYlZpZXdzLCBzbyB0aGUKICAvLyBhY2Nlc3NfdG9rZW4gY29va2llIChncl8xX2FjY2Vzc1Rva2VuKSBpcyB1c2VkIGFzIGZhbGxiYWNrLgogIChmdW5jdGlvbigpIHsKICAgIHRyeSB7CiAgICAgIGlmICh3aW5kb3cuX19ibEFkZHJBcGlGZXRjaGVkKSByZXR1cm47CiAgICAgIHZhciBfYmxGZXRjaEF0dGVtcHRzID0gMDsKICAgICAgZnVuY3Rpb24gX2JsQXV0b0ZldGNoKCkgewogICAgICAgIHRyeSB7CiAgICAgICAgICBpZiAod2luZG93Ll9fYmxBZGRyQXBpRmV0Y2hlZCkgcmV0dXJuOwogICAgICAgICAgX2JsRmV0Y2hBdHRlbXB0cysrOwogICAgICAgICAgdmFyIGFjY2Vzc1Rva2VuID0gd2luZG93Ll9fYmxHZXRBY2Nlc3NUb2tlbigpOwogICAgICAgICAgaWYgKCFhY2Nlc3NUb2tlbikgewogICAgICAgICAgICBpZiAoX2JsRmV0Y2hBdHRlbXB0cyA8IDEwKSBzZXRUaW1lb3V0KF9ibEF1dG9GZXRjaCwgMTAwMCk7CiAgICAgICAgICAgIHJldHVybjsKICAgICAgICAgIH0KICAgICAgICAgIHZhciBsb2NSYXcgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbSgnbG9jYXRpb24nKTsKICAgICAgICAgIHZhciBsYXQgPSAnMTIuOTcxNicsIGxuZyA9ICc3Ny41OTQ2JzsKICAgICAgICAgIGlmIChsb2NSYXcpIHsgdHJ5IHsgdmFyIGxvYyA9IEpTT04ucGFyc2UobG9jUmF3KTsgbGF0ID0gbG9jLmNvb3Jkcy5sYXQgfHwgbGF0OyBsbmcgPSBsb2MuY29vcmRzLmxvbiB8fCBsbmc7IH0gY2F0Y2ggKGUpIHt9IH0KICAgICAgICAgIHZhciBkZXZpY2VJZCA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKCdkZXZpY2VJZCcpIHx8ICcnOwogICAgICAgICAgZmV0Y2goJ2h0dHBzOi8vYmxpbmtpdC5jb20vdjQvYWRkcmVzcz9jdXJfbGF0PScgKyBsYXQgKyAnJmN1cl9sb249JyArIGxuZywgewogICAgICAgICAgICBtZXRob2Q6ICdHRVQnLAogICAgICAgICAgICBjcmVkZW50aWFsczogJ2luY2x1ZGUnLAogICAgICAgICAgICBoZWFkZXJzOiB7CiAgICAgICAgICAgICAgJ0FjY2VwdCc6ICdhcHBsaWNhdGlvbi9qc29uJywKICAgICAgICAgICAgICAnYWNjZXNzX3Rva2VuJzogYWNjZXNzVG9rZW4sCiAgICAgICAgICAgICAgJ2F1dGhfa2V5JzogJ2M3NjFlYzM2MzNjMjJhZmFkOTM0ZmIxN2E2NjM4NWMxYzA2YzU0NzJiNDg5OGI4NjZiNzMwNjE4NmQwYmI0NzcnLAogICAgICAgICAgICAgICdhcHBfY2xpZW50JzogJ2NvbnN1bWVyX3dlYicsCiAgICAgICAgICAgICAgJ2xhdCc6IGxhdCwKICAgICAgICAgICAgICAnbG9uJzogbG5nLAogICAgICAgICAgICAgICdkZXZpY2VfaWQnOiBkZXZpY2VJZCwKICAgICAgICAgICAgICAncGxhdGZvcm0nOiAnbW9iaWxlX3dlYicKICAgICAgICAgICAgfQogICAgICAgICAgfSkudGhlbihmdW5jdGlvbihyKSB7CiAgICAgICAgICAgIHdpbmRvdy5fX2JsQWRkckFwaUZldGNoZWQgPSB0cnVlOwogICAgICAgICAgICBpZiAoIXIub2spIHJldHVybiBudWxsOwogICAgICAgICAgICByZXR1cm4gci50ZXh0KCk7CiAgICAgICAgICB9KS50aGVuKGZ1bmN0aW9uKHQpIHsKICAgICAgICAgICAgaWYgKCF0KSByZXR1cm47CiAgICAgICAgICAgIHRyeSB7CiAgICAgICAgICAgICAgdmFyIGFqID0gSlNPTi5wYXJzZSh0KTsKICAgICAgICAgICAgICB2YXIgbGlzdCA9IGFqLmFkZHJlc3NlcyB8fCBhai5kYXRhIHx8IGFqLmFkZHJlc3Nlc19kYXRhIHx8IChBcnJheS5pc0FycmF5KGFqKSA/IGFqIDogbnVsbCk7CiAgICAgICAgICAgICAgaWYgKGxpc3QgJiYgIUFycmF5LmlzQXJyYXkobGlzdCkgJiYgbGlzdC5hZGRyZXNzZXNfZGF0YSkgbGlzdCA9IGxpc3QuYWRkcmVzc2VzX2RhdGE7CiAgICAgICAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkobGlzdCkgJiYgbGlzdC5sZW5ndGgpIHsKICAgICAgICAgICAgICAgIHZhciBhID0gbGlzdFswXTsKICAgICAgICAgICAgICAgIHZhciBhSWQgPSBhLmlkIHx8IGEuYWRkcmVzc19pZCB8fCAnJzsKICAgICAgICAgICAgICAgIHZhciBhTGF0ID0gYS5sYXRpdHVkZSB8fCBhLmxhdCB8fCAnJzsKICAgICAgICAgICAgICAgIHZhciBhTG5nID0gYS5sb25naXR1ZGUgfHwgYS5sbmcgfHwgYS5sb24gfHwgJyc7CiAgICAgICAgICAgICAgICBpZiAoYUlkKSB7IHdpbmRvdy5fX2JsU3RvcmVkQWRkcklkID0gU3RyaW5nKGFJZCk7IGxvY2FsU3RvcmFnZS5zZXRJdGVtKCdzZWxlY3RlZF9hZGRyZXNzX2lkJywgU3RyaW5nKGFJZCkpOyB9CiAgICAgICAgICAgICAgICBpZiAoYUxhdCAmJiBhTG5nKSB7IHdpbmRvdy5fX2JsU3RvcmVkTGF0ID0gU3RyaW5nKGFMYXQpOyB3aW5kb3cuX19ibFN0b3JlZExuZyA9IFN0cmluZyhhTG5nKTsgbG9jYWxTdG9yYWdlLnNldEl0ZW0oJ3NlbGVjdGVkX2xhdCcsIFN0cmluZyhhTGF0KSk7IGxvY2FsU3RvcmFnZS5zZXRJdGVtKCdzZWxlY3RlZF9sbmcnLCBTdHJpbmcoYUxuZykpOyB9CiAgICAgICAgICAgICAgICB3aW5kb3cuUmVhY3ROYXRpdmVXZWJWaWV3LnBvc3RNZXNzYWdlKEpTT04uc3RyaW5naWZ5KHsgdHlwZTogJ0JMX0FERFJfUkVTT0xWRUQnLCBhZGRyZXNzSWQ6IFN0cmluZyhhSWQpLCBsYXQ6IFN0cmluZyhhTGF0KSwgbG5nOiBTdHJpbmcoYUxuZykgfSkpOwogICAgICAgICAgICAgIH0KICAgICAgICAgICAgfSBjYXRjaCAoZSkge30KICAgICAgICAgIH0pLmNhdGNoKGZ1bmN0aW9uKCkgeyB3aW5kb3cuX19ibEFkZHJBcGlGZXRjaGVkID0gdHJ1ZTsgfSk7CiAgICAgICAgfSBjYXRjaCAoZSkge30KICAgICAgfQogICAgICBfYmxBdXRvRmV0Y2goKTsKICAgIH0gY2F0Y2ggKGUpIHt9CiAgfSkoKTsKCiAgdHJ5IHsKICAgIHZhciBzdG9yYWdlS2V5cyA9IFsnY2FydCcsICdjaGVja291dCddOwogICAgZm9yICh2YXIgc2kgPSAwOyBzaSA8IHN0b3JhZ2VLZXlzLmxlbmd0aDsgc2krKykgewogICAgICB2YXIgc3YgPSBTdHJpbmcobG9jYWxTdG9yYWdlLmdldEl0ZW0oc3RvcmFnZUtleXNbc2ldKSB8fCAnJyk7CiAgICAgIGlmIChzdikgewogICAgICAgIHdpbmRvdy5SZWFjdE5hdGl2ZVdlYlZpZXcucG9zdE1lc3NhZ2UoSlNPTi5zdHJpbmdpZnkoewogICAgICAgICAgdHlwZTogJ0JMX0xPQ0FMU1RPUkFHRScsIGtleTogc3RvcmFnZUtleXNbc2ldLCB2YWx1ZTogc3Yuc2xpY2UoMCwgNjAwMDApCiAgICAgICAgfSkpOwogICAgICB9CiAgICB9CiAgfSBjYXRjaCAoZTEwKSB7fQogIH0gY2F0Y2ggKGVNYWluKSB7fQp9KSgpOwo=';

interface BlinkitBridgeHandle {
  reload: () => void;
  injectJS: (js: string) => void;
}

const BlinkitBridgeWebView = forwardRef<BlinkitBridgeHandle>((_, ref) => {
  const webViewRef = useRef<WebView>(null);

  useImperativeHandle(ref, () => ({
    reload: () => {
      webViewRef.current?.reload();
    },
    injectJS: (js: string) => {
      webViewRef.current?.injectJavaScript(js);
    },
  }));

  useEffect(() => {
    const injector = (id: number, url: string, method: string, body: string, extraHeaders: string) => {
      webViewRef.current?.injectJavaScript(
        `window.__blHandleRequest(${id}, ${JSON.stringify(url)}, ${JSON.stringify(method)}, ${JSON.stringify(body)}, ${JSON.stringify(extraHeaders)}); true;`
      );
    };
    registerBlinkitInjector(injector);
    registerBlinkitBridgeReload(() => {
      webViewRef.current?.reload();
    });
    return () => {
      unregisterBlinkitInjector(injector);
      unregisterBlinkitBridgeReload();
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const injectAddress = async () => {
      try {
        const [addrId, bLat, bLng] = await Promise.all([
          AsyncStorage.getItem('@blinkit_address_id'),
          AsyncStorage.getItem('@blinkit_lat'),
          AsyncStorage.getItem('@blinkit_lng'),
        ]);
        if (!mounted) return;
        if (addrId || (bLat && bLng)) {
          webViewRef.current?.injectJavaScript(
            `window.__blSetDeliveryContext(${JSON.stringify(addrId || '')}, ${JSON.stringify(bLat || '')}, ${JSON.stringify(bLng || '')}); true;`
          );
        }
      } catch {}
    };

    const initTimer = setTimeout(injectAddress, 2000);
    pollTimer = setInterval(injectAddress, 2000);

    return () => {
      mounted = false;
      clearTimeout(initTimer);
      if (pollTimer) clearInterval(pollTimer);
    };
  }, []);

  const handleMessage = (event: any) => {
    const payload = String(event.nativeEvent.data || '');
    const cookieStr = takeBlinkitBridgeCookies();
    if (cookieStr) {
      webViewRef.current?.injectJavaScript(
        `window.__blApplyCookies(${JSON.stringify(cookieStr)}); true;`
      );
    }
    try {
      const msg = JSON.parse(payload);
      if (msg?.type === 'BL_ADDR_RESOLVED') {
        if (msg.addressId) AsyncStorage.setItem('@blinkit_address_id', msg.addressId);
        if (msg.lat && msg.lng) { AsyncStorage.setItem('@blinkit_lat', msg.lat); AsyncStorage.setItem('@blinkit_lng', msg.lng); }
      }
    } catch {}
    handleBlinkitBridgeMessage(payload);
  };

  return (
    <View style={styles.hidden} pointerEvents="none">
      <WebView
        ref={webViewRef}
        source={{ uri: 'https://blinkit.com/' }}
        onMessage={handleMessage}
        onLoadEnd={() => {
          webViewRef.current?.injectJavaScript(`
            (function(){
              var b64='${BRIDGE_SCRIPT_B64}';
              var js=atob(b64);
              var el=document.createElement('script');
              el.textContent=js;
              document.head.appendChild(el);
            })(); true;
          `);
        }}
        onError={(e) => console.warn('[BlinkitBridge] onError:', e.nativeEvent)}
        javaScriptEnabled
        domStorageEnabled
        sharedCookiesEnabled
        startInLoadingState={false}
        style={styles.web}
      />
    </View>
  );
});

BlinkitBridgeWebView.displayName = 'BlinkitBridgeWebView';
export default BlinkitBridgeWebView;

const styles = StyleSheet.create({
  hidden: {
    position: 'absolute',
    width: 1,
    height: 1,
    top: -9999,
    left: -9999,
    opacity: 0.01,
    overflow: 'hidden',
  },
  web: {
    flex: 1,
    backgroundColor: '#FFF',
  },
});

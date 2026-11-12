import React, { useEffect, useRef, useImperativeHandle, forwardRef, useCallback } from 'react';
import { AppState, StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  registerBlinkitInjector,
  unregisterBlinkitInjector,
  handleBlinkitBridgeMessage,
  takeBlinkitBridgeCookies,
  registerBlinkitBridgeReload,
  unregisterBlinkitBridgeReload,
  recoverBlinkitBridge,
} from '../services/blinkitBridge';

const BRIDGE_SCRIPT_B64 = 'CihmdW5jdGlvbigpIHsKICB0cnkgewogIGlmICh3aW5kb3cuX19ibEJyaWRnZUluc3RhbGxlZCkgcmV0dXJuOwogIHdpbmRvdy5fX2JsQnJpZGdlSW5zdGFsbGVkID0gdHJ1ZTsKICB3aW5kb3cuX19ibFNjcmlwdFJhbiA9IHRydWU7CgogIHdpbmRvdy5fX2JsU3RvcmVkQWRkcklkID0gbnVsbDsKICB3aW5kb3cuX19ibFN0b3JlZExhdCA9IG51bGw7CiAgd2luZG93Ll9fYmxTdG9yZWRMbmcgPSBudWxsOwogIHdpbmRvdy5fX2JsQWRkckFwaUZldGNoZWQgPSBmYWxzZTsKICB3aW5kb3cuX19ibENvbnRleHRQcm9taXNlID0gbnVsbDsKCiAgd2luZG93Ll9fYmxBcHBseUNvb2tpZXMgPSBmdW5jdGlvbihjb29raWVTdHIpIHsKICAgIHRyeSB7CiAgICAgIHZhciBwYXJ0cyA9IFN0cmluZyhjb29raWVTdHIgfHwgJycpLnNwbGl0KC87XFxzKi8pOwogICAgICBmb3IgKHZhciBpID0gMDsgaSA8IHBhcnRzLmxlbmd0aDsgaSsrKSB7CiAgICAgICAgaWYgKCFwYXJ0c1tpXSkgY29udGludWU7CiAgICAgICAgdmFyIGVxID0gcGFydHNbaV0uaW5kZXhPZignPScpOwogICAgICAgIGlmIChlcSA8PSAwKSBjb250aW51ZTsKICAgICAgICBkb2N1bWVudC5jb29raWUgPSBwYXJ0c1tpXSArICc7IHBhdGg9LzsgZG9tYWluPS5ibGlua2l0LmNvbTsgc2VjdXJlOyBTYW1lU2l0ZT1Ob25lJzsKICAgICAgfQogICAgfSBjYXRjaCAoZSkge30KICB9OwoKICB3aW5kb3cuX19ibEdldEFjY2Vzc1Rva2VuID0gZnVuY3Rpb24oKSB7CiAgICB0cnkgewogICAgICB2YXIgYXV0aFJhdyA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKCdhdXRoJyk7CiAgICAgIGlmIChhdXRoUmF3KSB7IHZhciBhbyA9IEpTT04ucGFyc2UoYXV0aFJhdyk7IGlmIChhby5hY2Nlc3NUb2tlbikgcmV0dXJuIGFvLmFjY2Vzc1Rva2VuOyB9CiAgICB9IGNhdGNoIChlKSB7fQogICAgdHJ5IHsKICAgICAgdmFyIGNvb2tpZXMgPSBkb2N1bWVudC5jb29raWUuc3BsaXQoJzsnKTsKICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBjb29raWVzLmxlbmd0aDsgaSsrKSB7CiAgICAgICAgdmFyIGMgPSBjb29raWVzW2ldLnRyaW0oKTsKICAgICAgICBpZiAoYy5pbmRleE9mKCdncl8xX2FjY2Vzc1Rva2VuPScpID09PSAwKSB7CiAgICAgICAgICByZXR1cm4gZGVjb2RlVVJJQ29tcG9uZW50KGMuc3Vic3RyaW5nKCdncl8xX2FjY2Vzc1Rva2VuPScubGVuZ3RoKSk7CiAgICAgICAgfQogICAgICB9CiAgICB9IGNhdGNoIChlMikge30KICAgIHJldHVybiAnJzsKICB9OwoKICB3aW5kb3cuX19ibFNldERlbGl2ZXJ5Q29udGV4dCA9IGZ1bmN0aW9uKGFkZHJJZCwgbGF0LCBsbmcpIHsKICAgIHRyeSB7CiAgICAgIGlmICghbGF0IHx8ICFsbmcpIHsKICAgICAgICB0cnkgewogICAgICAgICAgdmFyIGxzTGF0ID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oJ3NlbGVjdGVkX2xhdCcpOwogICAgICAgICAgdmFyIGxzTG5nID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oJ3NlbGVjdGVkX2xuZycpOwogICAgICAgICAgaWYgKGxzTGF0ICYmIGxzTG5nKSB7IGxhdCA9IGxhdCB8fCBsc0xhdDsgbG5nID0gbG5nIHx8IGxzTG5nOyB9CiAgICAgICAgfSBjYXRjaCAoZSkge30KICAgICAgfQogICAgICB3aW5kb3cuX19ibFN0b3JlZEFkZHJJZCA9IGFkZHJJZCB8fCBudWxsOwogICAgICB3aW5kb3cuX19ibFN0b3JlZExhdCA9IGxhdCB8fCBudWxsOwogICAgICB3aW5kb3cuX19ibFN0b3JlZExuZyA9IGxuZyB8fCBudWxsOwogICAgICBpZiAoYWRkcklkKSBsb2NhbFN0b3JhZ2Uuc2V0SXRlbSgnc2VsZWN0ZWRfYWRkcmVzc19pZCcsIFN0cmluZyhhZGRySWQpKTsKICAgICAgaWYgKGxhdCkgbG9jYWxTdG9yYWdlLnNldEl0ZW0oJ3NlbGVjdGVkX2xhdCcsIFN0cmluZyhsYXQpKTsKICAgICAgaWYgKGxuZykgbG9jYWxTdG9yYWdlLnNldEl0ZW0oJ3NlbGVjdGVkX2xuZycsIFN0cmluZyhsbmcpKTsKICAgICAgdHJ5IHsKICAgICAgICB2YXIgZXhpc3RpbmcgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbSgnYWRkcmVzc2VzX2RhdGEnKTsKICAgICAgICBpZiAoZXhpc3RpbmcgJiYgYWRkcklkKSB7CiAgICAgICAgICB2YXIgcGFyc2VkID0gSlNPTi5wYXJzZShleGlzdGluZyk7CiAgICAgICAgICBpZiAocGFyc2VkICYmIHBhcnNlZC5hZGRyZXNzZXMgJiYgQXJyYXkuaXNBcnJheShwYXJzZWQuYWRkcmVzc2VzLmFkZHJlc3Nlc19kYXRhKSkgewogICAgICAgICAgICB2YXIgbWF0Y2ggPSBwYXJzZWQuYWRkcmVzc2VzLmFkZHJlc3Nlc19kYXRhLmZpbmQoZnVuY3Rpb24oYSkgeyByZXR1cm4gU3RyaW5nKGEuaWQpID09PSBTdHJpbmcoYWRkcklkKTsgfSk7CiAgICAgICAgICAgIGlmIChtYXRjaCkgbG9jYWxTdG9yYWdlLnNldEl0ZW0oJ3NlbGVjdGVkX2FkZHJlc3NfaWQnLCBTdHJpbmcoYWRkcklkKSk7CiAgICAgICAgICB9CiAgICAgICAgfQogICAgICB9IGNhdGNoIChlMikge30KICAgICAgaWYgKGFkZHJJZCkgewogICAgICAgIHZhciBiTGF0ID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oJ3NlbGVjdGVkX2xhdCcpIHx8IGxhdCB8fCAnMTIuOTcxNic7CiAgICAgICAgdmFyIGJMbmcgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbSgnc2VsZWN0ZWRfbG5nJykgfHwgbG5nIHx8ICc3Ny41OTQ2JzsKICAgICAgICB2YXIgYWNjZXNzVG9rZW4gPSB3aW5kb3cuX19ibEdldEFjY2Vzc1Rva2VuKCk7CiAgICAgICAgdmFyIGRldmljZUlkID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oJ2RldmljZUlkJykgfHwgJyc7CiAgICAgICAgdmFyIGF1dGhLZXkgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbSgnYXV0aEtleScpIHx8ICcnOwogICAgICAgIHZhciBzZWxIID0geyAnQ29udGVudC1UeXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nLCAnQWNjZXB0JzogJ2FwcGxpY2F0aW9uL2pzb24nLCAnYWNjZXNzX3Rva2VuJzogYWNjZXNzVG9rZW4sICdhdXRoX2tleSc6IGF1dGhLZXksICdhcHBfY2xpZW50JzogJ2NvbnN1bWVyX3dlYicsICdsYXQnOiBiTGF0LCAnbG9uJzogYkxuZywgJ2RldmljZV9pZCc6IGRldmljZUlkLCAncGxhdGZvcm0nOiAnbW9iaWxlX3dlYicgfTsKICAgICAgICB2YXIgcEFsbCA9IFByb21pc2UuYWxsKFsKICAgICAgICAgIGZldGNoKCdodHRwczovL2JsaW5raXQuY29tL3YyL2FkZHJlc3Mvc2VsZWN0JywgeyBtZXRob2Q6ICdQT1NUJywgY3JlZGVudGlhbHM6ICdpbmNsdWRlJywgaGVhZGVyczogc2VsSCwgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBhZGRyZXNzX2lkOiBOdW1iZXIoYWRkcklkKSB9KSB9KS5jYXRjaChmdW5jdGlvbigpIHt9KSwKICAgICAgICAgIGZldGNoKCdodHRwczovL2JsaW5raXQuY29tL3YxL2FkZHJlc3Mvc2VsZWN0JywgeyBtZXRob2Q6ICdQT1NUJywgY3JlZGVudGlhbHM6ICdpbmNsdWRlJywgaGVhZGVyczogc2VsSCwgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBpZDogTnVtYmVyKGFkZHJJZCkgfSkgfSkuY2F0Y2goZnVuY3Rpb24oKSB7fSksCiAgICAgICAgICBmZXRjaCgnaHR0cHM6Ly9ibGlua2l0LmNvbS92MS9hZGRyZXNzZXMvc2VsZWN0JywgeyBtZXRob2Q6ICdQT1NUJywgY3JlZGVudGlhbHM6ICdpbmNsdWRlJywgaGVhZGVyczogc2VsSCwgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBhZGRyZXNzX2lkOiBOdW1iZXIoYWRkcklkKSB9KSB9KS5jYXRjaChmdW5jdGlvbigpIHt9KQogICAgICAgIF0pOwogICAgICAgIHZhciB0UCA9IG5ldyBQcm9taXNlKGZ1bmN0aW9uKHJlc29sdmUpIHsgc2V0VGltZW91dChyZXNvbHZlLCA0MDAwKTsgfSk7CiAgICAgICAgd2luZG93Ll9fYmxDb250ZXh0UHJvbWlzZSA9IFByb21pc2UucmFjZShbcEFsbCwgdFBdKTsKICAgICAgfQogICAgfSBjYXRjaCAoZSkge30KICB9OwoKICB3aW5kb3cuX19ibEhhbmRsZVJlcXVlc3QgPSBmdW5jdGlvbihpZCwgdXJsLCBtZXRob2QsIGJvZHksIGV4dHJhSGVhZGVyc0pzb24pIHsKICAgIHZhciBvcHRzID0gewogICAgICBtZXRob2Q6IG1ldGhvZCB8fCAnR0VUJywKICAgICAgY3JlZGVudGlhbHM6ICdpbmNsdWRlJywKICAgICAgaGVhZGVyczogeyAnQWNjZXB0JzogJ2FwcGxpY2F0aW9uL2pzb24sIHRleHQvcGxhaW4sICovKicgfQogICAgfTsKICAgIHRyeSB7CiAgICAgIHZhciBleHRyYSA9IEpTT04ucGFyc2UoZXh0cmFIZWFkZXJzSnNvbiB8fCAne30nKTsKICAgICAgZm9yICh2YXIgayBpbiBleHRyYSkgeyBpZiAoZXh0cmFba10pIG9wdHMuaGVhZGVyc1trXSA9IGV4dHJhW2tdOyB9CiAgICB9IGNhdGNoIChlMikge30KICAgIHRyeSB7CiAgICAgIHZhciBhayA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKCdhdXRoS2V5Jyk7CiAgICAgIGlmIChhayAmJiAhb3B0cy5oZWFkZXJzWydhdXRoX2tleSddKSBvcHRzLmhlYWRlcnNbJ2F1dGhfa2V5J10gPSBhazsKICAgIH0gY2F0Y2ggKGUzKSB7fQogICAgdHJ5IHsKICAgICAgaWYgKCFvcHRzLmhlYWRlcnNbJ2FjY2Vzc190b2tlbiddKSB7CiAgICAgICAgdmFyIGF0ID0gd2luZG93Ll9fYmxHZXRBY2Nlc3NUb2tlbiA/IHdpbmRvdy5fX2JsR2V0QWNjZXNzVG9rZW4oKSA6ICcnOwogICAgICAgIGlmIChhdCkgb3B0cy5oZWFkZXJzWydhY2Nlc3NfdG9rZW4nXSA9IGF0OwogICAgICB9CiAgICB9IGNhdGNoIChlMTIpIHt9CiAgICB0cnkgewogICAgICB2YXIgZHYgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbSgnZGV2aWNlSWQnKTsKICAgICAgaWYgKGR2KSB7CiAgICAgICAgaWYgKCFvcHRzLmhlYWRlcnNbJ0RldmljZUlEJ10pIG9wdHMuaGVhZGVyc1snRGV2aWNlSUQnXSA9IGR2OwogICAgICAgIGlmICghb3B0cy5oZWFkZXJzWydkZXZpY2VfaWQnXSkgb3B0cy5oZWFkZXJzWydkZXZpY2VfaWQnXSA9IGR2OwogICAgICAgIGlmICghb3B0cy5oZWFkZXJzWydkZXZpY2VpZCddKSBvcHRzLmhlYWRlcnNbJ2RldmljZWlkJ10gPSBkdjsKICAgICAgICBpZiAoIW9wdHMuaGVhZGVyc1sneC1kZXZpY2UtaWQnXSkgb3B0cy5oZWFkZXJzWyd4LWRldmljZS1pZCddID0gZHY7CiAgICAgIH0KICAgIH0gY2F0Y2ggKGUxMSkge30KICAgIGlmIChib2R5KSB7CiAgICAgIG9wdHMuaGVhZGVyc1snQ29udGVudC1UeXBlJ10gPSAnYXBwbGljYXRpb24vanNvbic7CiAgICAgIGlmICgvXC92NVwvY2FydHMvLnRlc3QodXJsKSAmJiBtZXRob2QgPT09ICdQT1NUJykgewogICAgICAgIHRyeSB7CiAgICAgICAgICB2YXIgYiA9IEpTT04ucGFyc2UoYm9keSk7CiAgICAgICAgICBpZiAoIWIuYWRkcmVzc19pZCAmJiB3aW5kb3cuX19ibFN0b3JlZEFkZHJJZCkgewogICAgICAgICAgICBiLmFkZHJlc3NfaWQgPSBOdW1iZXIod2luZG93Ll9fYmxTdG9yZWRBZGRySWQpOwogICAgICAgICAgICBib2R5ID0gSlNPTi5zdHJpbmdpZnkoYik7CiAgICAgICAgICB9CiAgICAgICAgfSBjYXRjaCAoZTQpIHt9CiAgICAgIH0KICAgICAgb3B0cy5ib2R5ID0gYm9keTsKICAgIH0KICAgIGZ1bmN0aW9uIHJ1bkZldGNoKCkgewogICAgICBmZXRjaCh1cmwsIG9wdHMpLnRoZW4oZnVuY3Rpb24ocmVzKSB7CiAgICAgICAgcmV0dXJuIHJlcy50ZXh0KCkudGhlbihmdW5jdGlvbih0KSB7CiAgICAgICAgICB3aW5kb3cuUmVhY3ROYXRpdmVXZWJWaWV3LnBvc3RNZXNzYWdlKEpTT04uc3RyaW5naWZ5KHsKICAgICAgICAgICAgdHlwZTogJ0JMX0FQSV9SRVNQT05TRScsIGlkOiBpZCwgc3RhdHVzOiByZXMuc3RhdHVzLCB0ZXh0OiBTdHJpbmcodCkuc2xpY2UoMCwgMTUwMDAwMCkKICAgICAgICAgIH0pKTsKICAgICAgICB9KTsKICAgICAgfSkuY2F0Y2goZnVuY3Rpb24oZSkgewogICAgICAgIHdpbmRvdy5SZWFjdE5hdGl2ZVdlYlZpZXcucG9zdE1lc3NhZ2UoSlNPTi5zdHJpbmdpZnkoewogICAgICAgICAgdHlwZTogJ0JMX0FQSV9SRVNQT05TRScsIGlkOiBpZCwgc3RhdHVzOiAwLCB0ZXh0OiBTdHJpbmcoKGUgJiYgZS5tZXNzYWdlKSB8fCBlKQogICAgICAgIH0pKTsKICAgICAgfSk7CiAgICB9CiAgICBpZiAod2luZG93Ll9fYmxDb250ZXh0UHJvbWlzZSAmJiAhL1wvYWRkcmVzcy8udGVzdCh1cmwpKSB7CiAgICAgIFByb21pc2UucmVzb2x2ZSh3aW5kb3cuX19ibENvbnRleHRQcm9taXNlKS50aGVuKHJ1bkZldGNoLCBydW5GZXRjaCk7CiAgICB9IGVsc2UgewogICAgICBydW5GZXRjaCgpOwogICAgfQogIH07CiAgd2luZG93LlJlYWN0TmF0aXZlV2ViVmlldy5wb3N0TWVzc2FnZShKU09OLnN0cmluZ2lmeSh7IHR5cGU6ICdCTF9CUklER0VfUkVBRFknIH0pKTsKCiAgLy8gQXV0by1mZXRjaCBhZGRyZXNzZXMgdmlhIC92NC9hZGRyZXNzIG9uIGV2ZXJ5IGJyaWRnZSBsb2FkLgogIC8vIEluIEFQSyBidWlsZHMsIGxvY2FsU3RvcmFnZSBpc24ndCBzaGFyZWQgYmV0d2VlbiBXZWJWaWV3cywgc28gdGhlCiAgLy8gYWNjZXNzX3Rva2VuIGNvb2tpZSAoZ3JfMV9hY2Nlc3NUb2tlbikgaXMgdXNlZCBhcyBmYWxsYmFjay4KICAoZnVuY3Rpb24oKSB7CiAgICB0cnkgewogICAgICBpZiAod2luZG93Ll9fYmxBZGRyQXBpRmV0Y2hlZCB8fCB3aW5kb3cuX19ibFN0b3JlZEFkZHJJZCkgcmV0dXJuOwogICAgICB2YXIgX2JsRmV0Y2hBdHRlbXB0cyA9IDA7CiAgICAgIGZ1bmN0aW9uIF9ibEF1dG9GZXRjaCgpIHsKICAgICAgICB0cnkgewogICAgICAgICAgaWYgKHdpbmRvdy5fX2JsQWRkckFwaUZldGNoZWQgfHwgd2luZG93Ll9fYmxTdG9yZWRBZGRySWQpIHJldHVybjsKICAgICAgICAgIF9ibEZldGNoQXR0ZW1wdHMrKzsKICAgICAgICAgIHZhciBhY2Nlc3NUb2tlbiA9IHdpbmRvdy5fX2JsR2V0QWNjZXNzVG9rZW4oKTsKICAgICAgICAgIGlmICghYWNjZXNzVG9rZW4pIHsKICAgICAgICAgICAgaWYgKF9ibEZldGNoQXR0ZW1wdHMgPCAxMCkgc2V0VGltZW91dChfYmxBdXRvRmV0Y2gsIDEwMDApOwogICAgICAgICAgICByZXR1cm47CiAgICAgICAgICB9CiAgICAgICAgICB2YXIgbG9jUmF3ID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oJ2xvY2F0aW9uJyk7CiAgICAgICAgICB2YXIgbGF0ID0gJzEyLjk3MTYnLCBsbmcgPSAnNzcuNTk0Nic7CiAgICAgICAgICBpZiAobG9jUmF3KSB7IHRyeSB7IHZhciBsb2MgPSBKU09OLnBhcnNlKGxvY1Jhdyk7IGxhdCA9IGxvYy5jb29yZHMubGF0IHx8IGxhdDsgbG5nID0gbG9jLmNvb3Jkcy5sb24gfHwgbG5nOyB9IGNhdGNoIChlKSB7fSB9CiAgICAgICAgICB2YXIgZGV2aWNlSWQgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbSgnZGV2aWNlSWQnKSB8fCAnJzsKICAgICAgICAgIGZldGNoKCdodHRwczovL2JsaW5raXQuY29tL3Y0L2FkZHJlc3M/Y3VyX2xhdD0nICsgbGF0ICsgJyZjdXJfbG9uPScgKyBsbmcsIHsKICAgICAgICAgICAgbWV0aG9kOiAnR0VUJywKICAgICAgICAgICAgY3JlZGVudGlhbHM6ICdpbmNsdWRlJywKICAgICAgICAgICAgaGVhZGVyczogewogICAgICAgICAgICAgICdBY2NlcHQnOiAnYXBwbGljYXRpb24vanNvbicsCiAgICAgICAgICAgICAgJ2FjY2Vzc190b2tlbic6IGFjY2Vzc1Rva2VuLAogICAgICAgICAgICAgICdhdXRoX2tleSc6ICdjNzYxZWMzNjMzYzIyYWZhZDkzNGZiMTdhNjYzODVjMWMwNmM1NDcyYjQ4OThiODY2YjczMDYxODZkMGJiNDc3JywKICAgICAgICAgICAgICAnYXBwX2NsaWVudCc6ICdjb25zdW1lcl93ZWInLAogICAgICAgICAgICAgICdsYXQnOiBsYXQsCiAgICAgICAgICAgICAgJ2xvbic6IGxuZywKICAgICAgICAgICAgICAnZGV2aWNlX2lkJzogZGV2aWNlSWQsCiAgICAgICAgICAgICAgJ3BsYXRmb3JtJzogJ21vYmlsZV93ZWInCiAgICAgICAgICAgIH0KICAgICAgICAgIH0pLnRoZW4oZnVuY3Rpb24ocikgewogICAgICAgICAgICB3aW5kb3cuX19ibEFkZHJBcGlGZXRjaGVkID0gdHJ1ZTsKICAgICAgICAgICAgaWYgKCFyLm9rKSByZXR1cm4gbnVsbDsKICAgICAgICAgICAgcmV0dXJuIHIudGV4dCgpOwogICAgICAgICAgfSkudGhlbihmdW5jdGlvbih0KSB7CiAgICAgICAgICAgIGlmICghdCB8fCB3aW5kb3cuX19ibFN0b3JlZEFkZHJJZCkgcmV0dXJuOwogICAgICAgICAgICB0cnkgewogICAgICAgICAgICAgIHZhciBhaiA9IEpTT04ucGFyc2UodCk7CiAgICAgICAgICAgICAgdmFyIGxpc3QgPSBhai5hZGRyZXNzZXMgfHwgYWouZGF0YSB8fCBhai5hZGRyZXNzZXNfZGF0YSB8fCAoQXJyYXkuaXNBcnJheShhaikgPyBhaiA6IG51bGwpOwogICAgICAgICAgICAgIGlmIChsaXN0ICYmICFBcnJheS5pc0FycmF5KGxpc3QpICYmIGxpc3QuYWRkcmVzc2VzX2RhdGEpIGxpc3QgPSBsaXN0LmFkZHJlc3Nlc19kYXRhOwogICAgICAgICAgICAgIGlmIChBcnJheS5pc0FycmF5KGxpc3QpICYmIGxpc3QubGVuZ3RoKSB7CiAgICAgICAgICAgICAgICB2YXIgYSA9IGxpc3RbMF07CiAgICAgICAgICAgICAgICB2YXIgYUlkID0gYS5pZCB8fCBhLmFkZHJlc3NfaWQgfHwgJyc7CiAgICAgICAgICAgICAgICB2YXIgYUxhdCA9IGEubGF0aXR1ZGUgfHwgYS5sYXQgfHwgJyc7CiAgICAgICAgICAgICAgICB2YXIgYUxuZyA9IGEubG9uZ2l0dWRlIHx8IGEubG5nIHx8IGEubG9uIHx8ICcnOwogICAgICAgICAgICAgICAgaWYgKGFJZCkgeyB3aW5kb3cuX19ibFN0b3JlZEFkZHJJZCA9IFN0cmluZyhhSWQpOyBsb2NhbFN0b3JhZ2Uuc2V0SXRlbSgnc2VsZWN0ZWRfYWRkcmVzc19pZCcsIFN0cmluZyhhSWQpKTsgfQogICAgICAgICAgICAgICAgaWYgKGFMYXQgJiYgYUxuZykgeyB3aW5kb3cuX19ibFN0b3JlZExhdCA9IFN0cmluZyhhTGF0KTsgd2luZG93Ll9fYmxTdG9yZWRMbmcgPSBTdHJpbmcoYUxuZyk7IGxvY2FsU3RvcmFnZS5zZXRJdGVtKCdzZWxlY3RlZF9sYXQnLCBTdHJpbmcoYUxhdCkpOyBsb2NhbFN0b3JhZ2Uuc2V0SXRlbSgnc2VsZWN0ZWRfbG5nJywgU3RyaW5nKGFMbmcpKTsgfQogICAgICAgICAgICAgICAgd2luZG93LlJlYWN0TmF0aXZlV2ViVmlldy5wb3N0TWVzc2FnZShKU09OLnN0cmluZ2lmeSh7IHR5cGU6ICdCTF9BRERSX1JFU09MVkVEJywgYWRkcmVzc0lkOiBTdHJpbmcoYUlkKSwgbGF0OiBTdHJpbmcoYUxhdCksIGxuZzogU3RyaW5nKGFMbmcpIH0pKTsKICAgICAgICAgICAgICB9CiAgICAgICAgICAgIH0gY2F0Y2ggKGUpIHt9CiAgICAgICAgICB9KS5jYXRjaChmdW5jdGlvbigpIHsgd2luZG93Ll9fYmxBZGRyQXBpRmV0Y2hlZCA9IHRydWU7IH0pOwogICAgICAgIH0gY2F0Y2ggKGUpIHt9CiAgICAgIH0KICAgICAgX2JsQXV0b0ZldGNoKCk7CiAgICB9IGNhdGNoIChlKSB7fQogIH0pKCk7CgogIHRyeSB7CiAgICB2YXIgc3RvcmFnZUtleXMgPSBbJ2NhcnQnLCAnY2hlY2tvdXQnXTsKICAgIGZvciAodmFyIHNpID0gMDsgc2kgPCBzdG9yYWdlS2V5cy5sZW5ndGg7IHNpKyspIHsKICAgICAgdmFyIHN2ID0gU3RyaW5nKGxvY2FsU3RvcmFnZS5nZXRJdGVtKHN0b3JhZ2VLZXlzW3NpXSkgfHwgJycpOwogICAgICBpZiAoc3YpIHsKICAgICAgICB3aW5kb3cuUmVhY3ROYXRpdmVXZWJWaWV3LnBvc3RNZXNzYWdlKEpTT04uc3RyaW5naWZ5KHsKICAgICAgICAgIHR5cGU6ICdCTF9MT0NBTFNUT1JBR0UnLCBrZXk6IHN0b3JhZ2VLZXlzW3NpXSwgdmFsdWU6IHN2LnNsaWNlKDAsIDYwMDAwKQogICAgICAgIH0pKTsKICAgICAgfQogICAgfQogIH0gY2F0Y2ggKGUxMCkge30KICB9IGNhdGNoIChlTWFpbikge30KfSkoKTsK';

interface BlinkitBridgeHandle {
  reload: () => void;
  injectJS: (js: string) => void;
}

const BlinkitBridgeWebView = forwardRef<BlinkitBridgeHandle>((_, ref) => {
  // `<object>`: react-native-webview 14.0.x defaults its props generic to `undefined`, which
  // collapses every prop to `never` (upstream issue #3977). Drop once Expo ships a fixed version.
  const webViewRef = useRef<WebView<object>>(null);
  // The delivery context the page currently holds (see injectAddress).
  const lastAppliedRef = useRef('');
  // False from the moment the page starts loading until its bridge script reports
  // ready: injecting earlier would call a function that doesn't exist yet.
  const pageReadyRef = useRef(false);
  const mountedRef = useRef(true);
  const injectInFlightRef = useRef<Promise<void> | null>(null);

  const injectAddress = useCallback((): Promise<void> => {
    if (injectInFlightRef.current) return injectInFlightRef.current;
    const p = (async () => {
      try {
        const [addrId, bLat, bLng] = await Promise.all([
          AsyncStorage.getItem('@blinkit_address_id'),
          AsyncStorage.getItem('@blinkit_lat'),
          AsyncStorage.getItem('@blinkit_lng'),
        ]);
        if (!mountedRef.current || !pageReadyRef.current) return;
        if (addrId || (bLat && bLng)) {
          // Every call makes the page POST three address-select requests to
          // blinkit.com. Sent every 2s forever, that traffic is what Cloudflare
          // was challenging the page for: apply the address only when it
          // changed, or after the page (re)loaded and lost it.
          const key = `${addrId || ''}|${bLat || ''}|${bLng || ''}`;
          if (key === lastAppliedRef.current) return;
          lastAppliedRef.current = key;
          webViewRef.current?.injectJavaScript(
            `window.__blSetDeliveryContext(${JSON.stringify(addrId || '')}, ${JSON.stringify(bLat || '')}, ${JSON.stringify(bLng || '')}); true;`
          );
        }
      } catch {}
    })().finally(() => {
      if (injectInFlightRef.current === p) injectInFlightRef.current = null;
    });
    injectInFlightRef.current = p;
    return p;
  }, []);

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

  // Returning from the background after a while: the page may have been frozen
  // or killed, so reload it proactively instead of waiting for a search to fail.
  useEffect(() => {
    let backgroundedAt = 0;
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background' || state === 'inactive') {
        if (!backgroundedAt) backgroundedAt = Date.now();
      } else if (state === 'active') {
        if (backgroundedAt && Date.now() - backgroundedAt > 30000) recoverBlinkitBridge();
        backgroundedAt = 0;
      }
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const initTimer = setTimeout(() => { void injectAddress(); }, 2000);
    const pollTimer = setInterval(() => { void injectAddress(); }, 2000);

    return () => {
      mountedRef.current = false;
      clearTimeout(initTimer);
      clearInterval(pollTimer);
    };
  }, [injectAddress]);

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
      // A (re)loaded page has lost the delivery context: apply it immediately
      // BEFORE telling blinkitBridge the page is ready, so queued searches
      // run behind the address-select POST rather than against a stale store.
      if (msg?.type === 'BL_BRIDGE_READY') {
        pageReadyRef.current = true;
        lastAppliedRef.current = '';
        void injectAddress().finally(() => {
          if (mountedRef.current && pageReadyRef.current) {
            handleBlinkitBridgeMessage(payload);
          }
        });
        return;
      }
      if (msg?.type === 'BL_ADDR_RESOLVED') {
        void AsyncStorage.getItem('@blinkit_address_id').then((existingId) => {
          if (existingId) return;
          if (msg.addressId != null && msg.addressId !== '') AsyncStorage.setItem('@blinkit_address_id', String(msg.addressId));
          if (msg.lat != null && msg.lng != null && msg.lat !== '' && msg.lng !== '') {
            AsyncStorage.setItem('@blinkit_lat', String(msg.lat));
            AsyncStorage.setItem('@blinkit_lng', String(msg.lng));
          }
        }).catch(() => {});
      }
    } catch {}
    handleBlinkitBridgeMessage(payload);
  };

  return (
    <View style={styles.hidden} pointerEvents="none">
      <WebView<object>
        ref={webViewRef}
        source={{ uri: 'https://blinkit.com/' }}
        onMessage={handleMessage}
        onLoadStart={() => { pageReadyRef.current = false; lastAppliedRef.current = ''; }}
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
        onRenderProcessGone={() => recoverBlinkitBridge()}
        onContentProcessDidTerminate={() => recoverBlinkitBridge()}
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

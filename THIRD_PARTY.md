# Third-party components

Better HMP7 application code and its original icon are available under the MIT license. Packaged distributions include notices for the Python libraries and native bridge used on their target platform. Additional upstream notices are in `licenses/`.

- Python and its standard library are distributed under the PSF license and the licenses in the interpreter's bundled LICENSE file. [Python licensing](https://docs.python.org/3/license.html)
- pywebview hosts the offline dashboard in the native web engine. Windows uses Microsoft Edge WebView2 and Python.NET. macOS uses WebKit and PyObjC. Linux uses system GTK and WebKitGTK. [pywebview](https://github.com/r0x0r/pywebview) · [WebView2](https://developer.microsoft.com/microsoft-edge/webview2/)
- pySerial provides local serial-device access. [pySerial](https://github.com/pyserial/pyserial)
- openpyxl and et_xmlfile are used by the Python export helpers and workbook tests. [openpyxl](https://pypi.org/project/openpyxl/) · [et_xmlfile](https://pypi.org/project/et-xmlfile/)
- PyInstaller bundles the application. The bootloader has a special exception for distributing bundled applications. [PyInstaller license](https://pyinstaller.org/en/stable/license.html)
- NSIS creates the Windows installer. [NSIS license](https://nsis.sourceforge.io/License)

Vaisala and HMP7 identify the supported instrument. This is an independent community project. Vaisala manuals, software, graphics and USB drivers are available from the manufacturer. [Vaisala Insight and drivers](https://www.vaisala.com/en/products/software/swinsight)

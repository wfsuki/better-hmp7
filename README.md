# Better HMP7

**Vaisala HMP7 温湿度探头的本地串口采集工具。** 插上 USB 转接线，在应用里选择串口即可查看实时曲线。Windows、macOS 和 Linux 共用一套原生桌面界面。采样、记录和导出都在接探头的电脑上完成。

An independent desktop monitor for the Vaisala HMP7 probe. Connect a local serial port, plot live measurements, record CSV, and export Excel or a printable report. Built with Python, Tk and pySerial. The application runs offline.

## 安装

在项目的 GitHub **Releases** 页面选择与系统和处理器对应的包。预编译版本的使用者无需安装 Python。

| 系统 | 安装包 | 使用方式 |
| --- | --- | --- |
| Windows 10 / 11 x64 | `Better-HMP7-版本-windows-x64-setup.exe` | 安装到当前用户，从开始菜单打开 |
| macOS Apple Silicon | `Better-HMP7-版本-macos-arm64.dmg` | 打开磁盘映像，将应用拖到 Applications |
| macOS Intel | `Better-HMP7-版本-macos-x86_64.dmg` | 使用与 Intel 芯片对应的包 |
| Ubuntu / Debian x64 桌面 | `better-hmp7_版本_amd64.deb` | 在下载目录执行 `sudo apt install ./better-hmp7_版本_amd64.deb` |

每个安装包都附有 SHA-256 校验文件。Windows 安装包未签名，macOS 安装包未使用 Apple Developer ID 签名和公证。安装时系统可能会提示确认来源。

## 连接探头

1. 使用与 HMP7 匹配的 USB 转接线，把探头接到当前电脑。Windows 首次连接时可能需要 Vaisala USB Instrument Driver，可在厂家页面的 **Software and drivers** 区域下载。[Vaisala 官方驱动入口](https://www.vaisala.com/en/products/software/swinsight)
2. 关闭正在占用同一串口的 Insight 或其他串口软件。启动 Better HMP7，点 **刷新**，选择对应的串口并点 **连接**。
3. Windows 端口名通常形如 `COM3`，macOS 通常是 `/dev/cu.*`，Linux 通常是 `/dev/ttyUSB*` 或 `/dev/ttyACM*`。实际端口由系统及转接线驱动决定。Linux 用户还需要对该设备的读写权限。

设备默认使用 **19200 bit/s、8 数据位、无校验、2 停止位、地址 240**。应用先用 Modbus RTU 核对设备标识，再读取测量寄存器。现场探头若设置为其他协议、速率或地址，这个版本可能无法识别它。它只读取探头，所有可操作的设置都属于本机应用。[Vaisala HMP 系列用户手册](https://docs.vaisala.com/r/M212022EN-M/en-US)

## 查看与记录

- **实时曲线** 默认显示温度和相对湿度。在「选择曲线」勾选更多参数，各曲线使用各自的单位和纵轴。滚轮缩放时间轴，拖动平移，双击图表或点「跟随实时」恢复。预览在内存里保留最近约 30 分钟，默认跟随最近 5 分钟。
- **测量明细** 有 18 项，包括露点、绝对湿度和水蒸气分压。「设备状态与参数」提供 12 个配置读数和 8 个状态读数。探头未就绪、输出锁定或固件不支持时，相应读数可为空。
- **开始记录** 前选择一个采样间隔，范围 0.5 到 5 秒，步进 0.5 秒。选择新的 CSV 文件名后才开始写入，一次记录中共用同一个间隔。串口响应较慢时使用实际时间戳。
- **停止记录** 后可以继续预览。CSV 每行包含 UTC 时间、带时区的本地时间以及全部 18 项测量。断开、拔线或退出时停止写入，已写出的行保存在原处。已有 CSV 文件受到保护。
- **导出记录** 可以生成 Excel 或独立的 HTML 测量报告。报告展示本次完整记录的统计和所选曲线，与实时图的局部缩放无关。打开报告点「打印 / 另存为 PDF」即可使用系统打印功能。开始新记录前可以导出上一段记录。

应用会在本机记住采样间隔和勾选的曲线。测量文件保存在你选择的位置，可以离线打开。

## 从源码运行

需要带 Tk 的 Python 3.11 或以上版本，发布构建使用 Python 3.12。Linux 上如缺少 Tk，Ubuntu / Debian 可安装 `python3-tk`。在仓库根目录执行：

```sh
python -m venv .venv
```

在 PowerShell 运行 `.venv\Scripts\Activate.ps1`，在 macOS / Linux 的 shell 运行 `. .venv/bin/activate`。随后执行：

```sh
python -m pip install .
python -m better_hmp7
```

## 构建安装包

```sh
python -m pip install ".[build]"
python -m unittest discover -s tests -v
python packaging/build.py --smoke-test
```

Windows 需要 NSIS 3，可将 `MAKENSIS` 指向编译器。macOS 使用系统自带的 `hdiutil`，Ubuntu / Debian 使用 `dpkg-deb`。Linux 无桌面的 CI 环境用 `xvfb-run -a` 运行 GUI 测试及带 `--smoke-test` 的构建。产物和校验文件写到 `dist/`，可用 `--out` 指定其他目录。

**只有 Windows 电脑也可以生成全部平台的安装包。** 将这个源码仓库上传到 GitHub，在 **Actions → Build desktop packages → Run workflow** 手动运行。四个任务分别在 Windows、Apple Silicon Mac、Intel Mac、Ubuntu 上编译和启动测试。全部完成后，在该次运行的 **Artifacts** 下载各平台产物。[GitHub 托管构建机](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) · [PyInstaller 构建说明](https://pyinstaller.org/en/stable/)

要准备正式发行，在 `pyproject.toml` 更新版本，提交后推送对应标签（例如 `v0.1.0`）。构建成功后会生成带安装包、SHA-256 的 **Draft release**。维护者核对文件后在 GitHub 发布。正常使用软件、运行测试和本机打包均无需 GitHub 账号。

## 许可和厂商关系

应用源码与原创图标采用 MIT 许可证。依赖、运行时和打包工具保有各自的声明。[项目许可证](LICENSE) · [第三方声明](THIRD_PARTY.md)

Better HMP7 是独立社区项目。Vaisala 与 HMP7 用于标明兼容设备。驱动与技术手册请从 Vaisala 获取。

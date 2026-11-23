"""Build the installer for the current OS. Run from any working directory."""
import argparse
import hashlib
from importlib import metadata
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tempfile
import tomllib


ROOT = Path(__file__).resolve().parents[1]
VERSION = tomllib.loads((ROOT/"pyproject.toml").read_text(encoding="utf-8"))["project"]["version"]
ASSETS = ROOT / "packaging/assets"
APP = "Better HMP7"
UI_FILES = ("index.html", "style.css", "metrics.js", "chart-view.js", "desktop.js", "xlsx.js", "app.js")


def run(*args, **options):
    subprocess.run(list(map(str,args)), check=True, cwd=ROOT, **options)


def collect_notices(dest):
    shutil.copytree(ROOT/"licenses",dest)
    shutil.copy2(ROOT/"LICENSE",dest/"Better-HMP7.txt")
    shutil.copy2(ROOT/"THIRD_PARTY.md",dest/"Third-party.txt")
    prefix = Path(sys.base_prefix)
    lib = Path(os.__file__).parent
    version = f"{sys.version_info.major}.{sys.version_info.minor}"
    candidates = [prefix/"LICENSE.txt", lib/"LICENSE.txt", lib/"LICENSE",
                  prefix/"share/doc/python"/"copyright", Path(f"/usr/share/doc/python{version}/copyright"),
                  ROOT/"packaging"/f"CPython-{version}-LICENSE.txt"]
    python_license = next((p for p in candidates if p.is_file()),None)
    if python_license is None:
        raise RuntimeError("Python license file missing from the build environment")
    shutil.copy2(python_license,dest/"Python.txt")
    libraries = {"pywebview", "pythonnet", "clr-loader", "cffi", "pycparser", "bottle", "typing-extensions", "proxy-tools"}
    for dependency in metadata.distributions():
        name = dependency.metadata["Name"].lower().replace("_", "-")
        if name not in libraries and not name.startswith("pyobjc-"):
            continue
        entries = [f for f in dependency.files or () if ".dist-info" in str(f) and
                   (f.name.upper().startswith(("LICENSE", "LICENCE", "COPYING", "NOTICE")))]
        for index, entry in enumerate(entries):
            shutil.copy2(dependency.locate_file(entry), dest / f"{name}-{index + 1}.txt")
        if not entries:
            (dest / f"{name}-notice.txt").write_text(
                f"{name} {dependency.version}\n{dependency.metadata.get('Author', '')}\n"
                + (dependency.metadata.get("License") or dependency.metadata.get("License-Expression") or "")
                + "\n" + (dependency.read_text("METADATA") or ""), encoding="utf-8")
    dist = metadata.distribution("pyinstaller")
    entry = next(f for f in dist.files if f.name == "COPYING.txt")
    shutil.copy2(dist.locate_file(entry),dest/"PyInstaller.txt")


def freeze(stage, notices, system):
    name = APP if system == "Darwin" else "better-hmp7"
    mode = "--onefile" if system == "Windows" else "--onedir"
    args = [sys.executable,"-m","PyInstaller","--noconfirm","--clean","--noupx",mode,"--windowed",
            "--name",name,"--paths",ROOT,"--specpath",stage,
            "--workpath",stage/"work","--distpath",stage/"bundle",
            "--add-data",f"{ROOT/'better_hmp7/fields.json'}{os.pathsep}better_hmp7",
            "--add-data",f"{ROOT/'better_hmp7/icon.png'}{os.pathsep}better_hmp7",
            "--add-data",f"{notices}{os.pathsep}licenses",
            "--exclude-module","serial.urlhandler", "--exclude-module", "tkinter"]
    for file in UI_FILES:
        args += ["--add-data", f"{ROOT / 'better_hmp7/ui' / file}{os.pathsep}better_hmp7/ui"]
    if system == "Windows":
        args += ["--icon",ASSETS/"icon.ico", "--hidden-import", "webview.platforms.edgechromium", "--hidden-import", "webview.platforms.winforms"]
    elif system == "Darwin":
        args += ["--icon",ASSETS/"icon.icns","--osx-bundle-identifier","org.betterhmp7.desktop", "--hidden-import", "webview.platforms.cocoa"]
    run(*args,ROOT/"packaging/entry.py")
    return stage/"bundle"/(name+{"Windows":".exe","Darwin":".app","Linux":""}[system])


def windows(app, dest, notices, stage):
    compiler = os.environ.get("MAKENSIS") or shutil.which("makensis")
    if not compiler:
        compiler = next((str(p) for env in ("ProgramFiles(x86)","ProgramFiles")
                         if os.environ.get(env) and (p:=Path(os.environ[env])/"NSIS/makensis.exe").exists()),None)
    if not compiler:
        raise RuntimeError("Install NSIS or set MAKENSIS to its compiler path")
    uninstall = stage/"remove-notices.nsh"
    uninstall.write_text("".join(f'Delete "$INSTDIR\\licenses\\{p.name}"\n' for p in sorted(notices.glob("*.txt"))),
                         encoding="utf-8-sig")
    package = dest/f"Better-HMP7-{VERSION}-windows-x64-setup.exe"
    defines = {"PACKAGE":package,"APP_EXE":app,"ICON":ASSETS/"icon.ico","PROJECT_LICENSE":ROOT/"LICENSE",
               "VERSION":VERSION,"NOTICES":notices,"UNINSTALL_NOTICES":uninstall}
    run(compiler,"/V2",*(f"/D{k}={v}" for k,v in defines.items()),ROOT/"packaging/windows.nsi")
    return package


def macos(app, dest, stage):
    arch = platform.machine().lower()
    mount = stage/"disk"
    mount.mkdir()
    run("ditto",app,mount/app.name)
    (mount/"Applications").symlink_to("/Applications",target_is_directory=True)
    package = dest/f"Better-HMP7-{VERSION}-macos-{arch}.dmg"
    run("hdiutil","create","-quiet","-ov","-format","UDZO","-volname",APP,"-srcfolder",mount,package)
    return package


def linux_app(stage, notices):
    # Use the system Python so GTK and WebKit's native system bindings match.
    app = stage / "linux-app"
    public = ROOT / "better_hmp7"
    target = app / "better_hmp7"
    (target / "ui").mkdir(parents=True)
    for name in ("__init__.py", "__main__.py", "app.py", "desktop.py", "catalog.py", "preferences.py", "probe.py", "fields.json", "icon.png"):
        shutil.copy2(public / name, target / name)
    for name in UI_FILES:
        shutil.copy2(public / "ui" / name, target / "ui" / name)
    shutil.copytree(notices, app / "licenses")
    for name, package in (("pywebview", "webview"), ("proxy-tools", "proxy_tools"),
                          ("pyserial", "serial"), ("bottle", "bottle.py"), ("typing-extensions", "typing_extensions.py")):
        dist = metadata.distribution(name)
        for entry in dist.files or ():
            if entry.parts[0] != package or entry.suffix not in {".py", ".js"}:
                continue
            target = app / entry
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(dist.locate_file(entry), target)
    launcher = app / "better-hmp7"
    launcher.write_text("#!/usr/bin/python3\nfrom better_hmp7.app import main\nmain()\n", encoding="utf-8")
    launcher.chmod(0o755)
    return app


def linux(app, dest, stage):
    arch = subprocess.check_output(["dpkg","--print-architecture"],text=True).strip()
    pkg = stage/"deb"
    target = pkg/"opt/better-hmp7"
    shutil.copytree(app,target,symlinks=True)
    bin_dir = pkg/"usr/bin"
    bin_dir.mkdir(parents=True)
    (bin_dir/"better-hmp7").symlink_to("/opt/better-hmp7/better-hmp7")
    desktop = pkg/"usr/share/applications"
    desktop.mkdir(parents=True)
    (desktop/"better-hmp7.desktop").write_text(
        "[Desktop Entry]\nType=Application\nName=Better HMP7\nExec=/opt/better-hmp7/better-hmp7\n"
        "Terminal=false\nIcon=better-hmp7\nCategories=Science;Utility;\n",encoding="utf-8")
    icon = pkg/"usr/share/icons/hicolor/256x256/apps"
    icon.mkdir(parents=True)
    shutil.copy2(ASSETS/"icon-256.png",icon/"better-hmp7.png")
    meta = pkg/"DEBIAN"
    meta.mkdir()
    (meta/"control").write_text(f"Package: better-hmp7\nVersion: {VERSION}\nSection: science\nPriority: optional\nArchitecture: {arch}\n"
        "Maintainer: wfsuki <19591058+wfsuki@users.noreply.github.com>\nDepends: python3 (>= 3.11), python3-gi, gir1.2-gtk-3.0, gir1.2-webkit2-4.1\n"
        "Description: Local serial monitor and logger for the Vaisala HMP7.\n",encoding="utf-8")
    package = dest/f"better-hmp7_{VERSION}_{arch}.deb"
    run("dpkg-deb","--root-owner-group","--build",pkg,package)
    return package


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out",type=Path,default=ROOT/"dist")
    parser.add_argument("--smoke-test",action="store_true",help="Start the packaged dashboard and verify its controls")
    args=parser.parse_args()
    system=platform.system()
    if system not in {"Windows","Darwin","Linux"}:
        parser.error("This OS has no installer target")
    if system=="Windows" and platform.machine().lower() not in {"amd64","x86_64"}:
        parser.error("The Windows installer target requires an x64 build host")
    dest=args.out.resolve()
    dest.mkdir(parents=True,exist_ok=True)
    build=ROOT/"build"
    build.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="package-",dir=build) as temp:
        stage=Path(temp)
        notices=stage/"notices"
        collect_notices(notices)
        app=linux_app(stage, notices) if system == "Linux" else freeze(stage, notices, system)
        if args.smoke_test:
            exe = app if system=="Windows" else app/"Contents/MacOS"/APP if system=="Darwin" else app/"better-hmp7"
            run(exe,"--smoke-test",timeout=100)
        if system=="Windows":
            package=windows(app,dest,notices,stage)
        elif system=="Darwin":
            package=macos(app,dest,stage)
        else:
            package=linux(app,dest,stage)
    with package.open("rb") as stream:
        digest=hashlib.file_digest(stream,"sha256").hexdigest()
    (dest/(package.name+".sha256")).write_text(digest+"  "+package.name+"\n",encoding="ascii")
    print(package)


if __name__=="__main__":
    main()

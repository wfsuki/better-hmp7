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
            "--exclude-module","serial.urlhandler"]
    if system == "Windows":
        args += ["--icon",ASSETS/"icon.ico"]
    elif system == "Darwin":
        args += ["--icon",ASSETS/"icon.icns","--osx-bundle-identifier","org.betterhmp7.desktop"]
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
        "Maintainer: Better HMP7 contributors\nDepends: libc6, libx11-6, libxft2, libfontconfig1, libxrender1, libxext6, zlib1g\n"
        "Description: Local serial monitor and logger for the Vaisala HMP7.\n",encoding="utf-8")
    package = dest/f"better-hmp7_{VERSION}_{arch}.deb"
    run("dpkg-deb","--root-owner-group","--build",pkg,package)
    return package


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out",type=Path,default=ROOT/"dist")
    parser.add_argument("--smoke-test",action="store_true",help="Open and close a hidden window in the packaged app")
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
        app=freeze(stage, notices, system)
        if args.smoke_test:
            exe = app if system=="Windows" else app/"Contents/MacOS"/APP if system=="Darwin" else app/"better-hmp7"
            run(exe,"--smoke-test",timeout=60)
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

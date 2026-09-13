' String Art Studio - silent launcher.
' Runs launch.ps1 with no console window. Double-click this, or use the
' Desktop / Start Menu shortcut that Install-Shortcuts.cmd creates.
Option Explicit
Dim sh, fso, root, cmd
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & root & "\launch.ps1"""
' 0 = hidden window, False = don't block
sh.Run cmd, 0, False

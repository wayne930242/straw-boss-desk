<#
.SYNOPSIS
  Saves a screenshot of the whole desktop to %USERPROFILE%\sbd-shots\<name>.png. Needs the interactive desktop: start it with ui-run.ps1.
#>
param([string]$Name = ('shot-' + (Get-Date -Format 'yyyyMMdd-HHmmss')))
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$dir = Join-Path $env:USERPROFILE 'sbd-shots'
if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
$file = Join-Path $dir ($Name + '.png')
$bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Host $file

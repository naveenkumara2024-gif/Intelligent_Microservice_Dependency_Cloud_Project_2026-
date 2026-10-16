# Renders every page of a PDF to PNG with Windows' built-in PDF engine (Windows.Data.Pdf), so the
# built report can be checked visually without installing Poppler. Usage:
#   powershell -File render_pages.ps1 -Pdf <file.pdf> -OutDir <folder> [-Scale 1.5]
param([Parameter(Mandatory = $true)][string]$Pdf, [Parameter(Mandatory = $true)][string]$OutDir, [double]$Scale = 1.5)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Storage.StorageFolder, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime]
$null = [Windows.Data.Pdf.PdfPageRenderOptions, Windows.Data.Pdf, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]

$asTaskOp = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } |
    Select-Object -First 1
$asTaskAction = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' } |
    Select-Object -First 1
function Await($op, [type]$type) { $t = $asTaskOp.MakeGenericMethod($type).Invoke($null, @($op)); $null = $t.Wait(-1); $t.Result }
function AwaitAction($action) { $t = $asTaskAction.Invoke($null, @($action)); $null = $t.Wait(-1) }

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync((Resolve-Path $Pdf).Path)) ([Windows.Storage.StorageFile])
$pdfDoc = Await ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
$folder = Await ([Windows.Storage.StorageFolder]::GetFolderFromPathAsync((Resolve-Path $OutDir).Path)) ([Windows.Storage.StorageFolder])
for ($i = 0; $i -lt $pdfDoc.PageCount; $i++) {
    $page = $pdfDoc.GetPage($i)
    $out = Await ($folder.CreateFileAsync(('page-{0:D2}.png' -f ($i + 1)), [Windows.Storage.CreationCollisionOption]::ReplaceExisting)) ([Windows.Storage.StorageFile])
    $stream = Await ($out.OpenAsync([Windows.Storage.FileAccessMode]::ReadWrite)) ([Windows.Storage.Streams.IRandomAccessStream])
    $opts = New-Object Windows.Data.Pdf.PdfPageRenderOptions
    $opts.DestinationWidth = [uint32]($page.Size.Width * $Scale)
    AwaitAction ($page.RenderToStreamAsync($stream, $opts))
    $stream.Dispose()
    $page.Dispose()
}
"rendered $($pdfDoc.PageCount) pages to $OutDir"

# Opens the built report in Microsoft Word, refreshes the table of contents and all fields (page
# numbers), saves it, and exports the PDF. Usage:
#   powershell -File update_fields.ps1 -Docx <path.docx> -Pdf <path.pdf>
param([Parameter(Mandatory = $true)][string]$Docx, [Parameter(Mandatory = $true)][string]$Pdf)
$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
try {
    $doc = $word.Documents.Open($Docx, $false, $false)
    $null = $doc.Fields.Update()
    foreach ($toc in $doc.TablesOfContents) { $toc.Update() }
    $doc.Repaginate()
    foreach ($toc in $doc.TablesOfContents) { $toc.Update() }   # again, now that pages are final
    $doc.Save()
    $doc.ExportAsFixedFormat($Pdf, 17)                          # 17 = wdExportFormatPDF
    "pages: " + $doc.ComputeStatistics(2)
    "words: " + $doc.ComputeStatistics(0)
    $doc.Close()
}
finally {
    $word.Quit()
}

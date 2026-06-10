# Weekly SEO ranking report wrapper.
# Runs seo-ranking-report.js and saves a dated copy to the user's Downloads folder.
# Registered as a Windows Scheduled Task ("ONeilBeats-SEO-Weekly").
# Self-heals: if the GSC token isn't set yet, the report errors and the error
# text lands in the output file — no crash, nothing to clean up.

$ErrorActionPreference = 'Continue'
$backend = "C:\Users\defaultuser0\OneDrive\Desktop\Work\O'Neil Beats\backend"
$downloads = Join-Path $env:USERPROFILE 'Downloads'
$stamp = Get-Date -Format 'yyyy-MM-dd'
$outFile = Join-Path $downloads "seo-ranking-report-$stamp.txt"

Set-Location $backend
$output = & node "scripts\seo-ranking-report.js" 2>&1 | Out-String
$header = "O'Neil Beats — SEO Ranking Report`r`nGenerated: $(Get-Date -Format 'yyyy-MM-dd HH:mm')`r`n" + ('=' * 60) + "`r`n"
($header + $output) | Out-File -FilePath $outFile -Encoding utf8
Write-Output "Saved report to $outFile"

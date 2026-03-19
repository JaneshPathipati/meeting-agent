# get-browser-tabs.ps1
# Returns JSON array of all open browser tab titles using Windows UI Automation

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$tabCondition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::TabItem
)

$browserNames = @("chrome", "msedge", "brave", "firefox", "opera", "vivaldi", "Arc")
$titles = @()

foreach ($bName in $browserNames) {
    $procs = Get-Process $bName -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero }
    foreach ($proc in $procs) {
        try {
            $root = [System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)
            $tabs = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $tabCondition)
            foreach ($tab in $tabs) {
                $name = $tab.Current.Name
                if ($name -and $name.Length -gt 0) {
                    $titles += $name
                }
            }
        } catch {
            # Skip this browser window if UI Automation fails
        }
    }
}

if ($titles.Count -eq 0) {
    Write-Output "[]"
} else {
    @($titles) | ConvertTo-Json -Compress
}

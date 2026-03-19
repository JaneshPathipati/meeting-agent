# check-mic-active.ps1
# Checks Windows Registry to find apps currently using mic or camera.
# HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone
# LastUsedTimeStop = 0 means the app is CURRENTLY using the mic.
# Returns JSON: { micActive: bool, apps: string[], camActive: bool, camApps: string[] }

function Get-ActiveMediaApps {
    param([string]$DeviceType)

    $basePath = "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\$DeviceType"
    $activeApps = @()

    if (-not (Test-Path $basePath)) {
        return $activeApps
    }

    # Non-packaged apps are under direct subkeys
    $subkeys = Get-ChildItem -Path $basePath -ErrorAction SilentlyContinue
    foreach ($key in $subkeys) {
        $keyName = $key.PSChildName
        if ($keyName -eq "NonPackaged") {
            # NonPackaged apps are nested one level deeper
            $npKeys = Get-ChildItem -Path $key.PSPath -ErrorAction SilentlyContinue
            foreach ($npKey in $npKeys) {
                try {
                    $stop = (Get-ItemProperty -Path $npKey.PSPath -Name "LastUsedTimeStop" -ErrorAction SilentlyContinue).LastUsedTimeStop
                    if ($stop -eq 0) {
                        $activeApps += $npKey.PSChildName
                    }
                } catch {}
            }
        } else {
            # Packaged apps
            try {
                $stop = (Get-ItemProperty -Path $key.PSPath -Name "LastUsedTimeStop" -ErrorAction SilentlyContinue).LastUsedTimeStop
                if ($stop -eq 0) {
                    $activeApps += $keyName
                }
            } catch {}
        }
    }

    return $activeApps
}

$micApps = Get-ActiveMediaApps -DeviceType "microphone"
$camApps = Get-ActiveMediaApps -DeviceType "webcam"

$result = [ordered]@{
    micActive = ($micApps.Count -gt 0)
    apps      = @($micApps)
    camActive = ($camApps.Count -gt 0)
    camApps   = @($camApps)
}

$result | ConvertTo-Json -Compress

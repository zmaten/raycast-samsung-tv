# Samsung TV for Raycast

Control a Samsung Smart TV (Tizen, 2016 and newer) from Raycast over your local Wi-Fi — no cloud, no Samsung account.

> Unofficial. Not affiliated with or endorsed by Samsung.

## Commands

| Command | What it does |
|---|---|
| **Turn On TV** | Wakes the TV with Wake-on-LAN and confirms it came up |
| **Turn Off TV** | Puts the TV into standby and confirms it went off |
| **Toggle TV Power** | On if off, off if on — good for a hotkey |
| **Open TV App** | Searchable list of installed apps, plus Live TV, HDMI, Source and Home |
| **Extend Mac Display to TV** | Turns the TV on and uses it as an extended display over AirPlay |
| **Disconnect TV Display** | Stops using the TV as a display |
| **Select TV** | Lists Samsung TVs on the network and picks which one to control |

## Setup

1. **Switch the TV on.** The extension finds it on your network automatically.
2. **Enable wake over Wi-Fi** on the TV: *Settings → General → Network → Expert Settings → Power On with Mobile* → On. Without it the TV can be turned off but not back on.
3. Run any command. The first time, the TV asks you to **Allow** the connection.

With one TV on the network there is nothing else to set. With several, pick one with **Select TV**. If the TV gets a new IP address, the extension finds it again by its MAC address.

All settings are optional overrides: IP address (if discovery is blocked on your network), MAC address and AirPlay name (both learned from the TV), and the pairing token.

**For Extend Mac Display to TV**, Raycast needs permission to control your computer: *System Settings → Privacy & Security → Accessibility* (on macOS 27: *Device Control and Data Access*). The TV must support AirPlay (most 2018+ models).

## How it works

| Feature | Mechanism |
|---|---|
| Discovery | SSDP search for Samsung's remote-control receiver, then a scan of port 8001 on the local /24 as fallback |
| Power on | Wake-on-LAN magic packet to the TV's Wi-Fi MAC |
| Power off, remote keys | Samsung remote-control WebSocket, `wss://<tv>:8002`, token-paired |
| App list | Probes known app IDs via `http://<tv>:8001/api/v2/applications/<id>` — Samsung removed the installed-apps listing on 2020+ firmware |
| Open / close apps | `POST` / `DELETE` on the same REST endpoint |
| Extended display | AppleScript drives Control Center → Screen Mirroring; the TV is matched by its AirPlay device ID from Bonjour |

### Adding apps that aren't listed

Open TV App → **Add App by ID** (⌘N). App IDs are listed in the [homebridge-samsung-tizen app list](https://tavicu.github.io/homebridge-samsung-tizen/extra/applications.html).

## Development

```bash
npm install
npm run dev     # loads the extension into Raycast with hot reload
npm run lint
```

-- Connect / disconnect macOS Screen Mirroring to an AirPlay device via Control Center.
-- usage: osascript airplay-display.applescript <airplay-device-id> connect|disconnect|status
--   <airplay-device-id> is the Bonjour TXT "deviceid", e.g. AA:BB:CC:DD:EE:FF
-- Prints: connected | disconnected | already-connected | already-disconnected | not-found | error: …
--
-- Notes for macOS 26/27:
--  * menu bar extras belong to MenuBarAgent (ControlCenter on older releases)
--  * Escape does not close the Control Center panel (keys go to the front app); clicking
--    its menu bar item again does, so the item is used as a toggle
--  * the panel rebuilds after every click, so element references are re-read each time

on controlCenterItem()
	repeat with procRef in {"MenuBarAgent", "ControlCenter"}
		set procName to contents of procRef
		tell application "System Events"
			if exists process procName then
				try
					repeat with grp in (UI elements of menu bar 1 of process procName)
						try
							if (value of attribute "AXIdentifier" of grp) is "com.apple.menuextra.controlcenter" then return contents of grp
						end try
						repeat with mi in (UI elements of grp)
							try
								if (value of attribute "AXIdentifier" of mi) is "com.apple.menuextra.controlcenter" then return contents of mi
							end try
						end repeat
					end repeat
				end try
			end if
		end tell
	end repeat
	return missing value
end controlCenterItem

on panelOpen()
	tell application "System Events" to return (count of windows of process "ControlCenter") > 0
end panelOpen

on openPanel(cc)
	repeat 3 times
		if not my panelOpen() then tell application "System Events" to click cc
		repeat 12 times
			delay 0.15
			if my panelOpen() then
				delay 0.3 -- let it finish building
				return true
			end if
		end repeat
	end repeat
	return false
end openPanel

on closePanel(cc)
	repeat 3 times
		if not my panelOpen() then return
		delay 0.4 -- a click while the panel is still rebuilding is ignored
		tell application "System Events" to click cc
		repeat 10 times
			delay 0.15
			if not my panelOpen() then return
		end repeat
	end repeat
end closePanel

-- depth-first search in the current panel by AXIdentifier (exact, or suffix match)
on findIn(el, wantedId, isSuffix, depth)
	if depth > 8 then return missing value
	tell application "System Events"
		set kids to {}
		try
			set kids to UI elements of el
		end try
		repeat with k in kids
			set ident to ""
			try
				set ident to (value of attribute "AXIdentifier" of k) as text
			end try
			if ident is wantedId or (isSuffix and ident ends with wantedId) then return contents of k
			set found to my findIn(k, wantedId, isSuffix, depth + 1)
			if found is not missing value then return found
		end repeat
	end tell
	return missing value
end findIn

on findInPanel(wantedId, isSuffix)
	try
		tell application "System Events" to set w to window 1 of process "ControlCenter"
		return my findIn(w, wantedId, isSuffix, 0)
	on error
		return missing value
	end try
end findInPanel

on run argv
	set deviceId to item 1 of argv
	set mode to item 2 of argv

	set cc to my controlCenterItem()
	if cc is missing value then return "error: Control Center menu bar item not found"
	-- a panel left over from a previous run may be mid-close or in a sub-view: start fresh
	my closePanel(cc)

	set tile to missing value
	repeat 2 times
		if not my openPanel(cc) then return "error: Control Center did not open"
		repeat 12 times
			set tile to my findInPanel("controlcenter-screen-mirroring", false)
			if tile is not missing value then exit repeat
			delay 0.2
		end repeat
		if tile is not missing value then exit repeat
		my closePanel(cc)
	end repeat
	if tile is missing value then
		my closePanel(cc)
		return "error: Screen Mirroring is not in Control Center"
	end if
	tell application "System Events" to click tile

	-- AirPlay discovery can take a few seconds after the TV wakes
	set device to missing value
	repeat 40 times
		delay 0.25
		set device to my findInPanel(deviceId, true)
		if device is not missing value then exit repeat
	end repeat
	if device is missing value then
		my closePanel(cc)
		return "not-found"
	end if

	tell application "System Events" to set isOn to ((value of device) as integer) is 1

	if mode is "status" then
		my closePanel(cc)
		if isOn then return "connected"
		return "disconnected"
	end if
	if mode is "connect" and isOn then
		my closePanel(cc)
		return "already-connected"
	end if
	if mode is "disconnect" and not isOn then
		my closePanel(cc)
		return "already-disconnected"
	end if

	tell application "System Events" to click device
	delay 1
	my closePanel(cc)
	if mode is "connect" then return "connected"
	return "disconnected"
end run

class_name MidiTimelinePlayer
extends RefCounted

var duration_us: int = 0
var current_us: int = -1
var current_tempo_us: int = 500_000
var events: Array = []
var tempo_changes: Array = []
var event_cursor: int = 0
var tempo_cursor: int = 0
var active_velocities: Dictionary = {}


func load_from_payload(payload: Dictionary) -> void:
	duration_us = maxi(0, int(payload.get("durationUs", 0)))
	events.clear()
	tempo_changes.clear()
	for raw_note in payload.get("notes", []):
		if not raw_note is Dictionary:
			continue
		var note := int(raw_note.get("note", -1))
		var velocity := clampi(int(raw_note.get("velocity", 0)), 0, 127)
		var start_us := maxi(0, int(raw_note.get("startUs", 0)))
		var end_us := maxi(start_us, int(raw_note.get("endUs", start_us)))
		if note < 0 or note > 127 or velocity == 0:
			continue
		events.append({ "at_us": start_us, "note": note, "velocity": velocity, "delta": 1 })
		events.append({ "at_us": end_us, "note": note, "velocity": velocity, "delta": -1 })
		duration_us = maxi(duration_us, end_us)
	for raw_tempo in payload.get("tempoChanges", []):
		if not raw_tempo is Dictionary:
			continue
		var value := int(raw_tempo.get("microsecondsPerBeat", 500_000))
		if value > 0:
			tempo_changes.append({ "at_us": maxi(0, int(raw_tempo.get("atUs", 0))), "value": value })
	if tempo_changes.is_empty():
		tempo_changes.append({ "at_us": 0, "value": 500_000 })
	events.sort_custom(_sort_events)
	tempo_changes.sort_custom(func(left, right): return int(left.at_us) < int(right.at_us))
	reset()


func _sort_events(left: Dictionary, right: Dictionary) -> bool:
	if int(left.at_us) == int(right.at_us):
		return int(left.delta) < int(right.delta)
	return int(left.at_us) < int(right.at_us)


func reset() -> void:
	current_us = -1
	current_tempo_us = 500_000
	event_cursor = 0
	tempo_cursor = 0
	active_velocities.clear()


func seek(target_us: int) -> void:
	var safe_target := maxi(0, target_us)
	if safe_target < current_us:
		reset()
	while event_cursor < events.size() and int(events[event_cursor].at_us) <= safe_target:
		_apply_event(events[event_cursor])
		event_cursor += 1
	while tempo_cursor < tempo_changes.size() and int(tempo_changes[tempo_cursor].at_us) <= safe_target:
		current_tempo_us = int(tempo_changes[tempo_cursor].value)
		tempo_cursor += 1
	current_us = safe_target


func _apply_event(event: Dictionary) -> void:
	var note := int(event.note)
	var velocity := int(event.velocity)
	if int(event.delta) > 0:
		if not active_velocities.has(note):
			active_velocities[note] = []
		active_velocities[note].append(velocity)
		return
	if not active_velocities.has(note):
		return
	active_velocities[note].erase(velocity)
	if active_velocities[note].is_empty():
		active_velocities.erase(note)


func get_active_velocity(note: int) -> int:
	if not active_velocities.has(note):
		return 0
	var maximum := 0
	for velocity in active_velocities[note]:
		maximum = maxi(maximum, int(velocity))
	return maximum


func get_bpm() -> float:
	return 60_000_000.0 / float(maxi(1, current_tempo_us))


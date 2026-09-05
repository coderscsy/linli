extends SceneTree

const TimelinePlayer := preload("res://timeline.gd")


func _initialize() -> void:
	var timeline = TimelinePlayer.new()
	timeline.load_from_payload({
		"durationUs": 500_000,
		"notes": [
			{ "startUs": 0, "endUs": 250_000, "note": 60, "velocity": 80 },
			{ "startUs": 100_000, "endUs": 400_000, "note": 60, "velocity": 100 },
		],
		"tempoChanges": [
			{ "atUs": 0, "microsecondsPerBeat": 500_000 },
			{ "atUs": 300_000, "microsecondsPerBeat": 1_000_000 },
		],
	})
	timeline.seek(0)
	assert(timeline.get_active_velocity(60) == 80)
	timeline.seek(150_000)
	assert(timeline.get_active_velocity(60) == 100)
	timeline.seek(300_000)
	assert(timeline.get_active_velocity(60) == 100)
	assert(roundi(timeline.get_bpm()) == 60)
	timeline.seek(450_000)
	assert(timeline.get_active_velocity(60) == 0)
	print("GODOT_TIMELINE_TEST_OK")
	quit(0)


extends Control

const TimelinePlayer := preload("res://timeline.gd")
const FIRST_MIDI_NOTE := 21
const LAST_MIDI_NOTE := 108
const BLACK_PITCH_CLASSES := [1, 3, 6, 8, 10]
const BACKGROUND := Color("080b18")
const WHITE_IDLE := Color("e9edf5")
const WHITE_ACTIVE := Color("73c6ff")
const BLACK_IDLE := Color("151a2b")
const BLACK_ACTIVE := Color("a977ff")

var timeline_path := ""
var requested_output := ""
var requested_title := "本地 MIDI 演奏"
var render_width := 1920
var render_height := 1080
var render_fps := 60
var frame_index := 0
var timeline = TimelinePlayer.new()
var keys: Dictionary = {}
var title_label: Label
var status_label: Label
var progress_bar: ProgressBar


func _ready() -> void:
	set_process(false)
	_parse_arguments(OS.get_cmdline_user_args())
	if timeline_path.is_empty():
		_fail("缺少 --timeline 参数")
		return
	get_window().size = Vector2i(render_width, render_height)
	var file := FileAccess.open(timeline_path, FileAccess.READ)
	if file == null:
		_fail("无法读取时间线文件")
		return
	var payload = JSON.parse_string(file.get_as_text())
	if not payload is Dictionary:
		_fail("时间线 JSON 无效")
		return
	requested_title = str(payload.get("title", requested_title)) if requested_title == "本地 MIDI 演奏" else requested_title
	timeline.load_from_payload(payload)
	_build_stage()
	set_process(true)


func _parse_arguments(arguments: PackedStringArray) -> void:
	var index := 0
	while index < arguments.size():
		var argument := arguments[index]
		if index + 1 >= arguments.size():
			break
		var value := arguments[index + 1]
		match argument:
			"--timeline":
				timeline_path = value
			"--output":
				requested_output = value
			"--width":
				render_width = maxi(640, int(value))
			"--height":
				render_height = maxi(360, int(value))
			"--fps":
				render_fps = clampi(int(value), 24, 120)
			"--title":
				requested_title = value
			_:
				index += 1
				continue
		index += 2


func _build_stage() -> void:
	var background := ColorRect.new()
	background.color = BACKGROUND
	background.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	add_child(background)

	title_label = Label.new()
	title_label.text = requested_title
	title_label.position = Vector2(64, 48)
	title_label.size = Vector2(render_width - 128, 72)
	title_label.add_theme_font_size_override("font_size", 42)
	title_label.add_theme_color_override("font_color", Color("f5f7ff"))
	add_child(title_label)

	var local_label := Label.new()
	local_label.text = "本地 MIDI 演奏"
	local_label.position = Vector2(66, 122)
	local_label.size = Vector2(500, 36)
	local_label.add_theme_font_size_override("font_size", 20)
	local_label.add_theme_color_override("font_color", Color("8190ae"))
	add_child(local_label)

	status_label = Label.new()
	status_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_RIGHT
	status_label.position = Vector2(render_width - 620, 76)
	status_label.size = Vector2(556, 52)
	status_label.add_theme_font_size_override("font_size", 24)
	status_label.add_theme_color_override("font_color", Color("c6d1e8"))
	add_child(status_label)

	progress_bar = ProgressBar.new()
	progress_bar.show_percentage = false
	progress_bar.position = Vector2(64, 174)
	progress_bar.size = Vector2(render_width - 128, 14)
	progress_bar.max_value = maxf(1.0, float(timeline.duration_us))
	add_child(progress_bar)
	_build_keyboard()


func _build_keyboard() -> void:
	var keyboard_left := 60.0
	var keyboard_width := float(render_width) - keyboard_left * 2.0
	var keyboard_top := float(render_height) * 0.42
	var keyboard_height := float(render_height) * 0.48
	var white_width := keyboard_width / 52.0
	var black_width := white_width * 0.62
	var white_index := 0

	for note in range(FIRST_MIDI_NOTE, LAST_MIDI_NOTE + 1):
		if _is_black(note):
			continue
		var key := ColorRect.new()
		key.color = WHITE_IDLE
		key.position = Vector2(keyboard_left + white_index * white_width + 1.0, keyboard_top)
		key.size = Vector2(white_width - 2.0, keyboard_height)
		add_child(key)
		keys[note] = key
		white_index += 1

	for note in range(FIRST_MIDI_NOTE, LAST_MIDI_NOTE + 1):
		if not _is_black(note):
			continue
		var whites_before := 0
		for previous in range(FIRST_MIDI_NOTE, note):
			if not _is_black(previous):
				whites_before += 1
		var key := ColorRect.new()
		key.color = BLACK_IDLE
		key.position = Vector2(keyboard_left + whites_before * white_width - black_width * 0.5, keyboard_top)
		key.size = Vector2(black_width, keyboard_height * 0.63)
		add_child(key)
		keys[note] = key


func _is_black(note: int) -> bool:
	return posmod(note, 12) in BLACK_PITCH_CLASSES


func _process(_delta: float) -> void:
	var elapsed_us := int(frame_index * 1_000_000 / render_fps)
	timeline.seek(elapsed_us)
	_update_keyboard()
	progress_bar.value = mini(elapsed_us, timeline.duration_us)
	status_label.text = "%s / %s    %d BPM" % [
		_format_time(elapsed_us),
		_format_time(timeline.duration_us),
		int(round(timeline.get_bpm())),
	]
	frame_index += 1
	if elapsed_us > timeline.duration_us + 250_000:
		get_tree().quit(0)


func _update_keyboard() -> void:
	for note in range(FIRST_MIDI_NOTE, LAST_MIDI_NOTE + 1):
		var velocity := timeline.get_active_velocity(note)
		var key: ColorRect = keys[note]
		if _is_black(note):
			key.color = BLACK_IDLE if velocity == 0 else BLACK_ACTIVE.lightened(float(velocity) / 127.0 * 0.12)
		else:
			key.color = WHITE_IDLE if velocity == 0 else WHITE_ACTIVE.lightened(float(velocity) / 127.0 * 0.12)


func _format_time(value_us: int) -> String:
	var total_seconds := maxi(0, int(value_us / 1_000_000))
	return "%02d:%02d" % [int(total_seconds / 60), total_seconds % 60]


func _fail(message: String) -> void:
	push_error(message)
	get_tree().quit(1)

/** Names for the emoji people commonly react with, so the agent reads "thumbsup", not just "👍". */
const NAMES: Record<string, string> = {
  '👍': 'thumbsup', '👎': 'thumbsdown', '👌': 'ok_hand', '✅': 'white_check_mark', '☑️': 'ballot_box_with_check',
  '✔️': 'heavy_check_mark', '❌': 'x', '❎': 'negative_squared_cross_mark', '🚫': 'no_entry_sign', '⛔': 'no_entry',
  '❓': 'question', '❔': 'grey_question', '❗': 'exclamation', '‼️': 'bangbang', '🤔': 'thinking', '🧐': 'monocle_face',
  '👀': 'eyes', '🔁': 'repeat', '🔄': 'arrows_counterclockwise', '♻️': 'recycle', '⏹️': 'stop_button', '🛑': 'octagonal_sign',
  '⏸️': 'pause_button', '▶️': 'arrow_forward', '⏩': 'fast_forward', '❤️': 'heart', '💙': 'blue_heart', '💚': 'green_heart',
  '🙏': 'pray', '🙌': 'raised_hands', '👏': 'clap', '🎉': 'tada', '🥳': 'partying_face', '🔥': 'fire', '💯': '100',
  '🚀': 'rocket', '⭐': 'star', '🌟': 'star2', '😂': 'joy', '🤣': 'rofl', '😄': 'smile', '😅': 'sweat_smile', '🙂': 'slight_smile',
  '😉': 'wink', '😍': 'heart_eyes', '😮': 'open_mouth', '😱': 'scream', '😢': 'cry', '😭': 'sob', '😡': 'rage', '🤯': 'exploding_head',
  '🫡': 'saluting_face', '🤝': 'handshake', '💪': 'muscle', '🧠': 'brain', '💡': 'bulb', '📌': 'pushpin', '📎': 'paperclip',
  '📝': 'memo', '✏️': 'pencil2', '📋': 'clipboard', '📅': 'date', '⏰': 'alarm_clock', '⏳': 'hourglass_flowing_sand',
  '⌛': 'hourglass', '🐛': 'bug', '🔧': 'wrench', '🛠️': 'tools', '⚠️': 'warning', '🆗': 'ok', '🆕': 'new', '🔝': 'top',
  '⬆️': 'arrow_up', '⬇️': 'arrow_down', '➡️': 'arrow_right', '⬅️': 'arrow_left', '1️⃣': 'one', '2️⃣': 'two', '3️⃣': 'three',
  '4️⃣': 'four', '5️⃣': 'five', '🤖': 'robot', '🗑️': 'wastebasket', '🔕': 'no_bell', '🔔': 'bell', '📣': 'mega', '🙋': 'raising_hand',
  '🤷': 'shrug', '🫠': 'melting_face', '💀': 'skull', '👋': 'wave', '🐐': 'goat', '🥚': 'egg', '🍳': 'cooking',
};

export function emojiName(emoji: string): string {
  return NAMES[emoji] ?? NAMES[emoji.replace(/️/g, '')] ?? emoji;
}

/** Emoji that ask the bot to stop what it's doing. */
export const STOP_EMOJI = new Set(['⏹️', '🛑', '⛔']);

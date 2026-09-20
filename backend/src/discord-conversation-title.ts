const UI_ANNOTATION = /^(?:muted|unread|selected|online|idle|offline|invisible|do not disturb|direct message|group message|direct chat|group chat|\d+\s+members?)$/i;
const TYPE_ANNOTATION = /\s*\((?:direct message|group message|direct chat|group chat)\)/gi;

export function normalizeDiscordConversationTitle(label: string): string {
  const parts = label
    .replace(TYPE_ANNOTATION, "")
    .split(",")
    .map((part) => part.trim());

  while (parts.length > 1 && UI_ANNOTATION.test(parts[0] ?? "")) {
    parts.shift();
  }

  while (parts.length > 1 && UI_ANNOTATION.test(parts.at(-1) ?? "")) {
    parts.pop();
  }

  return parts.join(", ").replace(/,\s*$/, "").trim();
}

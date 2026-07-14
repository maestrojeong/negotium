export function topicAppLink(topicId: string): string {
  return `otium://topic/${encodeURIComponent(topicId)}`;
}

export function topicMarkdownLink(topicId: string): string {
  return `[Open topic](${topicAppLink(topicId)})`;
}

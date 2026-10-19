/**
 * What the Activity page shows instead of the raw action code. The codes
 * (`voiceover.generate`) stay in the database and in the filter's values;
 * this is only how they read.
 */
const LABELS: Record<string, string> = {
  "account.approve": "Account approved",
  "admin.user.view": "Account viewed by an operator",
  "admin.users.list": "Accounts listed by an operator",
  "auth.passwordReset.completed": "Password reset",
  "auth.passwordReset.requested": "Password reset requested",
  "automation.autoApprove": "Script approved automatically",
  "project.merge": "Projects merged",
  "publish.clearStuckPublication": "Stuck upload cleared",
  "publish.reclaimFootageStorage": "Footage files cleaned up",
  "publish.reclaimRenderStorage": "Render files cleaned up",
  "schedule.topics.refill": "Schedule topics refilled",
  "script.generate": "Script written",
  "script.import": "Script imported",
  "series.generateNow": "Series video started",
  "video.renarrate": "New voice requested",
  "voiceover.generate": "Narration recorded",
};

/** `schedule.topics.refill` → "Schedule topics refill": never dots or camelCase. */
function humanize(action: string): string {
  const words = action
    .split(".")
    .flatMap((part) => part.replace(/([a-z])([A-Z])/g, "$1 $2").split(" "))
    .map((word) => word.toLowerCase());
  const sentence = words.join(" ");
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

export function actionLabel(action: string): string {
  return LABELS[action] ?? humanize(action);
}

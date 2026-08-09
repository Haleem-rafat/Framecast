import { z } from "zod";

export const createVideoSchema = z.object({
  projectId: z.string().uuid(),
  title: z.string().min(1, "Title is required").max(120),
  topic: z.string().min(3, "Give the topic a few more words").max(300),
});

export type CreateVideoInput = z.infer<typeof createVideoSchema>;

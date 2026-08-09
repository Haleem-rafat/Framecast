import type { videoService } from "@/services/video.service";

export type VideoListItem = Awaited<ReturnType<typeof videoService.list>>[number];
export type VideoDetail = Awaited<ReturnType<typeof videoService.get>>;

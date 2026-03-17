import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile } from "@ffmpeg/util";

let ffmpegInstance: FFmpeg | null = null;

async function getFFmpeg(): Promise<FFmpeg> {
  if (ffmpegInstance?.loaded) return ffmpegInstance;
  const { FFmpeg } = await import("@ffmpeg/ffmpeg");
  ffmpegInstance = new FFmpeg();
  await ffmpegInstance.load();
  return ffmpegInstance;
}

/** Convert WebM blob to MP4. CRF 18 = near-lossless, preserves resolution. Returns MP4 blob or null on error. */
export async function webmToMp4(webmBlob: Blob): Promise<Blob | null> {
  const id = Math.random().toString(36).slice(2, 8);
  const inFile = `in_${id}.webm`;
  const outFile = `out_${id}.mp4`;
  try {
    const ffmpeg = await getFFmpeg();
    const input = await fetchFile(webmBlob);
    await ffmpeg.writeFile(inFile, input);
    const exitCode = await ffmpeg.exec([
      "-i", inFile,
      "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p",
      "-c:v", "libx264", "-crf", "18", "-preset", "medium",
      "-c:a", "aac", "-b:a", "192k",
      "-movflags", "+faststart",
      outFile
    ]);
    if (exitCode !== 0) return null;
    const data = await ffmpeg.readFile(outFile);
    await ffmpeg.deleteFile(inFile);
    await ffmpeg.deleteFile(outFile);
    return new Blob([data as Uint8Array], { type: "video/mp4" });
  } catch {
    return null;
  }
}

/** Convert MP4 blob to WebM. Returns WebM blob or null on error. */
export async function mp4ToWebm(mp4Blob: Blob): Promise<Blob | null> {
  const id = Math.random().toString(36).slice(2, 8);
  const inFile = `in_${id}.mp4`;
  const outFile = `out_${id}.webm`;
  try {
    const ffmpeg = await getFFmpeg();
    const input = await fetchFile(mp4Blob);
    await ffmpeg.writeFile(inFile, input);
    const exitCode = await ffmpeg.exec([
      "-i", inFile,
      "-c:v", "libvpx-vp9", "-crf", "18", "-b:v", "0",
      "-c:a", "libopus", "-b:a", "192k",
      outFile
    ]);
    if (exitCode !== 0) return null;
    const data = await ffmpeg.readFile(outFile);
    await ffmpeg.deleteFile(inFile);
    await ffmpeg.deleteFile(outFile);
    return new Blob([data as Uint8Array], { type: "video/webm" });
  } catch {
    return null;
  }
}

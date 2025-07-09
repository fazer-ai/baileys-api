import { path } from "@ffmpeg-installer/ffmpeg";
import ffmpeg from "fluent-ffmpeg";

ffmpeg.setFfmpegPath(path);

export default ffmpeg;

import { useEffect, useRef, useState } from "react";

export default function SyncedPlayer({ videoUrl, audioUrl }) {
  const videoRef = useRef(null);
  const audioRef = useRef(null);

  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);

  // Audio drives the timeline — video just loops silently underneath
  useEffect(() => {
    const audio = audioRef.current;
    const video = videoRef.current;
    if (!audio || !video) return;

    // Silence the video — audio track is the voiceover
    video.muted = true;
    video.loop = true;

    const onLoadedMetadata = () => {
      setDuration(audio.duration || 0);
    };

    const onTimeUpdate = () => {
      setCurrentTime(audio.currentTime);
    };

    const onEnded = () => {
      setPlaying(false);
      video.pause();
      video.currentTime = 0;
    };

    audio.addEventListener("loadedmetadata", onLoadedMetadata);
    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("ended", onEnded);

    return () => {
      audio.removeEventListener("loadedmetadata", onLoadedMetadata);
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("ended", onEnded);
    };
  }, [audioUrl, videoUrl]);

  const togglePlay = async () => {
    const audio = audioRef.current;
    const video = videoRef.current;
    if (!audio || !video) return;

    if (playing) {
      audio.pause();
      video.pause();
      setPlaying(false);
    } else {
      try {
        await video.play();
        await audio.play();
        setPlaying(true);
      } catch (err) {
        console.error("Playback error:", err);
      }
    }
  };

  const handleSeek = (e) => {
    const audio = audioRef.current;
    const video = videoRef.current;
    if (!audio || !video) return;

    const newTime = parseFloat(e.target.value);
    audio.currentTime = newTime;
    // Video loops independently — no need to seek it
    setCurrentTime(newTime);
  };

  const handleVolume = (e) => {
    const val = parseFloat(e.target.value);
    setVolume(val);
    if (audioRef.current) audioRef.current.volume = val;
    setMuted(val === 0);
  };

  const toggleMute = () => {
    const audio = audioRef.current;
    if (!audio) return;
    const next = !muted;
    audio.muted = next;
    setMuted(next);
  };

  const formatTime = (s) => {
    if (!s || isNaN(s)) return "0:00";
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60).toString().padStart(2, "0");
    return `${m}:${sec}`;
  };

  const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div className="synced-player">
      {/* Hidden audio element */}
      <audio ref={audioRef} src={audioUrl} preload="metadata" />

      {/* Video — looping, muted, visual only */}
      <div className="synced-video-wrapper">
        <video
          ref={videoRef}
          src={videoUrl}
          className="synced-video"
          preload="auto"
          playsInline
          muted
          loop
        />

        {/* Big play overlay when paused */}
        {!playing && (
          <button className="play-overlay" onClick={togglePlay} aria-label="Play">
            ▶
          </button>
        )}
      </div>

      {/* Custom controls */}
      <div className="synced-controls">
        {/* Play / Pause */}
        <button className="ctrl-btn play-btn" onClick={togglePlay} aria-label={playing ? "Pause" : "Play"}>
          {playing ? "⏸" : "▶"}
        </button>

        {/* Time */}
        <span className="ctrl-time">{formatTime(currentTime)}</span>

        {/* Seek bar */}
        <div className="ctrl-seek-wrapper">
          <div className="ctrl-seek-track">
            <div className="ctrl-seek-fill" style={{ width: `${progressPercent}%` }} />
          </div>
          <input
            type="range"
            className="ctrl-seek-input"
            min={0}
            max={duration || 0}
            step={0.1}
            value={currentTime}
            onChange={handleSeek}
          />
        </div>

        {/* Duration */}
        <span className="ctrl-time">{formatTime(duration)}</span>

        {/* Mute */}
        <button className="ctrl-btn mute-btn" onClick={toggleMute} aria-label={muted ? "Unmute" : "Mute"}>
          {muted ? "🔇" : "🔊"}
        </button>

        {/* Volume */}
        <input
          type="range"
          className="ctrl-volume"
          min={0}
          max={1}
          step={0.05}
          value={muted ? 0 : volume}
          onChange={handleVolume}
        />
      </div>

      <p className="synced-hint">
        Video and Audio Generated
      </p>
    </div>
  );
}

import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Play,
  Pause,
  SkipForward,
  SkipBack,
  Shuffle,
  Repeat,
  Volume2,
  VolumeX,
  FolderOpen,
  Music,
  ListMusic,
  FileAudio,
  FileText,
  Sun,
  Moon
} from "lucide-react";

interface Song {
  id: String;
  path: string;
  title: string;
  artist: string;
  album: string;
  duration: number;
  cover_art: string | null;
  lyrics_path: string | null;
}

interface LyricLine {
  time: number; // in seconds
  text: string;
}

function parseLRC(lrcText: string): LyricLine[] {
  const lines = lrcText.split(/\r?\n/);
  const lyrics: LyricLine[] = [];
  const timeRegex = /\[(\d{2}):(\d{2})\.(\d{2,3})\]/g;

  for (const line of lines) {
    const text = line.replace(/\[\d{2}:\d{2}\.\d{2,3}\]/g, "").trim();
    if (!text && line.includes("]")) continue; // Skip metadata lines like [by:...]

    let match;
    timeRegex.lastIndex = 0;
    while ((match = timeRegex.exec(line)) !== null) {
      const minutes = parseInt(match[1], 10);
      const seconds = parseInt(match[2], 10);
      const msStr = match[3];
      const milliseconds = parseInt(msStr.padEnd(3, '0').slice(0, 3), 10);
      const time = minutes * 60 + seconds + milliseconds / 1000;
      lyrics.push({ time, text });
    }
  }

  return lyrics.sort((a, b) => a.time - b.time);
}

export default function App() {
  // Playlist / Songs States
  const [folderPath, setFolderPath] = useState<string>("");
  const [songs, setSongs] = useState<Song[]>([]);
  const [currentSong, setCurrentSong] = useState<Song | null>(null);

  // Playback States
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.8);
  const [isMuted, setIsMuted] = useState(false);
  const [isShuffle, setIsShuffle] = useState(false);
  const [repeatMode, setRepeatMode] = useState<"none" | "all" | "one">("all");

  // Lyrics States
  const [lyrics, setLyrics] = useState<LyricLine[]>([]);
  const [currentLyricIndex, setCurrentLyricIndex] = useState(-1);
  const [userScrolled, setUserScrolled] = useState(false);

  // Styling States
  const [isSidebarOpen, setIsSidebarOpen] = useState(false); // Hidden by default
  const [isLyricsOpen, setIsLyricsOpen] = useState(true); // Open by default
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    return (localStorage.getItem("theme") as "dark" | "light") || "dark";
  });
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    return parseInt(localStorage.getItem("sidebar_width") || "240", 10);
  });
  const [isResizing, setIsResizing] = useState(false);
  const [lyricsWidth, setLyricsWidth] = useState(() => {
    return parseInt(localStorage.getItem("lyrics_width") || "240", 10);
  });
  const [isLyricsResizing, setIsLyricsResizing] = useState(false);

  // Drag and Drop State
  const [isDragging, setIsDragging] = useState(false);

  // Refs
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const lyricsContainerRef = useRef<HTMLDivElement>(null);
  const scrollTimeoutRef = useRef<any>(null);
  const lyricRefs = useRef<(HTMLDivElement | null)[]>([]);

  // Theme Persistence
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("theme", theme);
    getCurrentWindow().setTheme(theme).catch((err) => {
      console.error("Failed to set window theme:", err);
    });
  }, [theme]);

  // Sidebar Resize Persistence
  useEffect(() => {
    localStorage.setItem("sidebar_width", sidebarWidth.toString());
  }, [sidebarWidth]);

  // Sidebar Drag Handler
  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      let newWidth = e.clientX;
      if (newWidth < 190) newWidth = 190;
      if (newWidth > 400) newWidth = 400;
      setSidebarWidth(newWidth);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isResizing]);

  // Lyrics Resize Persistence
  useEffect(() => {
    localStorage.setItem("lyrics_width", lyricsWidth.toString());
  }, [lyricsWidth]);

  // Lyrics Drag Handler
  useEffect(() => {
    if (!isLyricsResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      let newWidth = window.innerWidth - e.clientX;
      if (newWidth < 190) newWidth = 190;
      if (newWidth > 400) newWidth = 400;
      setLyricsWidth(newWidth);
    };

    const handleMouseUp = () => {
      setIsLyricsResizing(false);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isLyricsResizing]);

  // Load saved folder on launch
  useEffect(() => {
    const savedFolder = localStorage.getItem("last_music_folder");
    if (savedFolder) {
      loadFolder(savedFolder);
    }
  }, []);

  // System Tray Listeners & Window Drag-Drop Listeners
  useEffect(() => {
    const unsubscribes: Promise<() => void>[] = [];

    unsubscribes.push(listen("tray-play-pause", () => togglePlay()));
    unsubscribes.push(listen("tray-next", () => playNext()));
    unsubscribes.push(listen("tray-prev", () => playPrev()));
    unsubscribes.push(listen("tauri://drag-over", () => setIsDragging(true)));
    unsubscribes.push(listen("tauri://drag-leave", () => setIsDragging(false)));
    unsubscribes.push(
      listen<{ paths: string[] }>("tauri://drag-drop", (event) => {
        setIsDragging(false);
        if (event.payload.paths && event.payload.paths.length > 0) {
          loadFolder(event.payload.paths[0]);
        }
      })
    );

    return () => {
      unsubscribes.forEach((unsub) => unsub.then((f) => f()));
    };
  }, [songs, currentSong, isPlaying, isShuffle, repeatMode]);

  // Handle Song Change
  useEffect(() => {
    if (!currentSong) {
      setLyrics([]);
      setCurrentLyricIndex(-1);
      return;
    }

    // Load Lyrics
    if (currentSong.lyrics_path) {
      invoke<string>("get_lyrics", { lyricsPath: currentSong.lyrics_path })
        .then((lrcContent) => {
          const parsed = parseLRC(lrcContent);
          setLyrics(parsed);
          setCurrentLyricIndex(-1);
        })
        .catch((err) => {
          console.error("Failed to read lyrics:", err);
          setLyrics([]);
        });
    } else {
      setLyrics([]);
    }

    // Start playback
    if (audioRef.current) {
      audioRef.current.src = convertFileSrc(currentSong.path);
      audioRef.current.load();
      if (isPlaying) {
        audioRef.current.play().catch((e) => console.log("Audio play error:", e));
      }
    }
  }, [currentSong]);

  // Sync volume to audio element
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = isMuted ? 0 : volume;
    }
  }, [volume, isMuted]);

  // Sync current lyric index as time updates
  useEffect(() => {
    if (lyrics.length === 0) {
      setCurrentLyricIndex(-1);
      return;
    }

    const index = lyrics.findIndex(
      (line, i) =>
        currentTime >= line.time &&
        (i === lyrics.length - 1 || currentTime < lyrics[i + 1].time)
    );

    if (index !== currentLyricIndex) {
      setCurrentLyricIndex(index);
    }
  }, [currentTime, lyrics]);

  // Scroll active lyric into view
  useEffect(() => {
    if (
      currentLyricIndex >= 0 &&
      !userScrolled &&
      lyricsContainerRef.current &&
      lyricRefs.current[currentLyricIndex]
    ) {
      const activeEl = lyricRefs.current[currentLyricIndex];
      const container = lyricsContainerRef.current;

      if (activeEl && container) {
        const top = activeEl.offsetTop - container.clientHeight / 2 + activeEl.clientHeight / 2;
        container.scrollTo({
          top,
          behavior: "smooth",
        });
      }
    }
  }, [currentLyricIndex, userScrolled]);

  // Select folder manually
  const selectFolder = async () => {
    const chosen = await invoke<string | null>("select_folder");
    if (chosen) {
      loadFolder(chosen);
    }
  };

  // Load a directory
  const loadFolder = async (path: string) => {
    try {
      const list = await invoke<Song[]>("scan_folder", { folderPath: path });
      if (list && list.length > 0) {
        setSongs(list);
        setFolderPath(path);
        localStorage.setItem("last_music_folder", path);
        if (!currentSong) {
          setCurrentSong(list[0]);
        }
      }
    } catch (err) {
      console.error("Error scanning directory:", err);
    }
  };

  // Playback Control Functions
  const togglePlay = () => {
    if (!currentSong) return;
    if (isPlaying) {
      audioRef.current?.pause();
      setIsPlaying(false);
    } else {
      audioRef.current?.play()
        .then(() => setIsPlaying(true))
        .catch((e) => console.log("Play failed:", e));
    }
  };

  // Keep togglePlay reference fresh for the keydown listener
  const togglePlayRef = useRef(togglePlay);
  useEffect(() => {
    togglePlayRef.current = togglePlay;
  });

  // Global Keyboard Shortcuts (Spacebar to toggle play/pause)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        const activeEl = document.activeElement;
        if (activeEl && (activeEl.tagName === "INPUT" || activeEl.tagName === "TEXTAREA")) {
          return;
        }
        e.preventDefault();
        togglePlayRef.current();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  const playNext = () => {
    if (songs.length === 0) return;
    if (isShuffle) {
      const filteredIndex = Math.floor(Math.random() * songs.length);
      setCurrentSong(songs[filteredIndex]);
      return;
    }

    const currentIndex = songs.findIndex((s) => s.path === currentSong?.path);
    let nextIndex = currentIndex + 1;
    if (nextIndex >= songs.length) {
      nextIndex = 0;
    }
    setCurrentSong(songs[nextIndex]);
  };

  const playPrev = () => {
    if (songs.length === 0) return;
    
    if (currentTime > 3 && audioRef.current) {
      audioRef.current.currentTime = 0;
      setCurrentTime(0);
      return;
    }

    if (isShuffle) {
      const filteredIndex = Math.floor(Math.random() * songs.length);
      setCurrentSong(songs[filteredIndex]);
      return;
    }

    const currentIndex = songs.findIndex((s) => s.path === currentSong?.path);
    let prevIndex = currentIndex - 1;
    if (prevIndex < 0) {
      prevIndex = songs.length - 1;
    }
    setCurrentSong(songs[prevIndex]);
  };

  const handleTimeUpdate = () => {
    if (audioRef.current) {
      setCurrentTime(audioRef.current.currentTime);
    }
  };

  const handleLoadedMetadata = () => {
    if (audioRef.current) {
      setDuration(audioRef.current.duration);
    }
  };

  const handleAudioEnded = () => {
    if (repeatMode === "one" && audioRef.current) {
      audioRef.current.currentTime = 0;
      audioRef.current.play().catch((e) => console.log(e));
    } else if (repeatMode === "none" && songs.findIndex((s) => s.path === currentSong?.path) === songs.length - 1) {
      setIsPlaying(false);
    } else {
      playNext();
    }
  };

  const handleProgressChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newTime = parseFloat(e.target.value);
    setCurrentTime(newTime);
    if (audioRef.current) {
      audioRef.current.currentTime = newTime;
    }
  };

  const handleLyricClick = (time: number) => {
    if (audioRef.current) {
      audioRef.current.currentTime = time;
      setCurrentTime(time);
      setUserScrolled(false);
    }
  };

  const handleLyricsScroll = () => {
    setUserScrolled(true);
    if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);
    scrollTimeoutRef.current = setTimeout(() => {
      setUserScrolled(false);
    }, 4000);
  };

  const formatTime = (secs: number) => {
    if (isNaN(secs)) return "00:00";
    const minutes = Math.floor(secs / 60);
    const seconds = Math.floor(secs % 60);
    return `${minutes.toString().padStart(2, "0")}:${seconds
      .toString()
      .padStart(2, "0")}`;
  };

  return (
    <div data-theme={theme} className="flex flex-col h-screen w-full select-none text-brand-normal bg-brand-black overflow-hidden relative">
      {/* Immersive Blurred Cover Art Background */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none z-0">
        <div className="absolute inset-0 bg-brand-dark/90" />
        {currentSong?.cover_art ? (
          <img
            src={currentSong.cover_art}
            alt=""
            className="w-full h-full object-cover blur-[100px] opacity-[0.22] scale-110 transition-all duration-1000 ease-in-out"
          />
        ) : (
          <div className="w-full h-full bg-brand-black" />
        )}
      </div>

      {/* Drag & Drop Overlay */}
      {isDragging && (
        <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-brand-black/80 backdrop-blur-md border-2 border-brand-white/70 border-dashed m-3 rounded-xl pointer-events-none">
          <FolderOpen className="w-16 h-16 text-brand-white animate-bounce mb-3" />
          <h2 className="text-xl font-medium text-brand-white">Drop music folder here</h2>
          <p className="text-brand-muted text-sm mt-1">Import all MP3 and LRC files in the folder</p>
        </div>
      )}

      {/* 2. Main Area (Split screen with Drawers) */}
      <div className="flex flex-1 overflow-hidden relative z-10">
        {/* Library Drawer (Inline, splits the space) */}
        <aside
          style={{ width: isSidebarOpen ? `${sidebarWidth}px` : "0px" }}
          className={`border-r border-brand-border/40 bg-brand-dark/20 backdrop-blur-sm flex flex-col overflow-hidden shrink-0 relative ${
            isResizing ? "" : "transition-all duration-300 ease-in-out"
          } ${
            isSidebarOpen ? "opacity-100" : "opacity-0 pointer-events-none border-r-0"
          }`}
        >
          <div className="w-full h-full flex flex-col min-w-[190px] shrink-0">
            <div className="p-3">
              <button
                onClick={selectFolder}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-xs bg-brand-panel/60 hover:bg-brand-border hover:text-brand-white border border-brand-border/60 transition-all cursor-pointer truncate shadow-sm text-brand-normal font-medium active:scale-[0.98]"
                title={folderPath || "Select Music Folder"}
              >
                <FolderOpen className="w-3.5 h-3.5 text-brand-muted shrink-0" />
                <span className="truncate text-left flex-1">
                  {folderPath ? folderPath.split("/").pop() : "Select Folder"}
                </span>
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-2 pb-4">
              {songs.length === 0 ? (
                <div className="flex flex-col items-center justify-center text-center p-6 mt-10 text-brand-muted">
                  <FileAudio className="w-9 h-9 mb-2 opacity-35 text-brand-normal" />
                  <p className="text-xs">No audio files found</p>
                </div>
              ) : (
                <div className="flex flex-col gap-0.5">
                  {songs.map((song) => {
                    const isActive = currentSong?.path === song.path;
                    return (
                      <button
                        key={song.path}
                        onClick={() => {
                          setCurrentSong(song);
                          setIsPlaying(true);
                        }}
                        className={`w-full flex items-center gap-3 p-2.5 rounded-xl text-left transition-all cursor-pointer ${
                          isActive
                            ? "bg-brand-panel text-brand-white"
                            : "hover:bg-brand-panel/30 text-brand-muted hover:text-brand-normal"
                        }`}
                      >
                        <div className="w-9 h-9 rounded-lg bg-brand-panel flex items-center justify-center overflow-hidden shrink-0 border border-brand-border">
                          {song.cover_art ? (
                            <img
                              src={song.cover_art}
                              alt=""
                              className="w-full h-full object-cover"
                            />
                          ) : (
                            <Music className={`w-4 h-4 ${isActive ? "text-brand-white" : "text-brand-muted"}`} />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className={`text-xs font-semibold truncate ${isActive ? "text-brand-white" : "text-brand-normal"}`}>
                            {song.title}
                          </p>
                          <p className="text-[10px] text-brand-muted truncate mt-0.5">
                            {song.artist}
                          </p>
                        </div>
                        <div className="text-[10px] text-brand-muted font-medium shrink-0">
                          {formatTime(song.duration)}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Resize Handle */}
            {isSidebarOpen && (
              <div
                onMouseDown={(e) => {
                  e.preventDefault();
                  setIsResizing(true);
                }}
                className={`absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-brand-border-active/50 active:bg-brand-border-active transition-colors z-20 ${
                  isResizing ? "bg-brand-border-active w-[2px]" : "bg-transparent"
                }`}
              />
            )}
          </div>
        </aside>

        {/* Left Panel / Main content: Large Ambient Cover Art card & Details */}
        <div className="flex-1 flex flex-col justify-center items-center p-8 select-none bg-transparent transition-all duration-300">
          {currentSong ? (
            <div className="flex flex-col items-center text-center w-full max-w-sm">
              {/* floating cover art with blurred replica background drop-shadow */}
              <div className="relative group">
                {currentSong.cover_art && (
                  <img
                    src={currentSong.cover_art}
                    alt=""
                    className="absolute -bottom-4 left-1/2 -translate-x-1/2 w-[90%] h-full rounded-2xl blur-2xl opacity-40 scale-95 select-none pointer-events-none transition-transform duration-700 group-hover:scale-100"
                  />
                )}
                <div
                  className={`w-80 h-80 rounded-2xl overflow-hidden bg-brand-panel border border-brand-border shadow-2xl relative z-10 transition-all duration-500 ease-out hover:scale-102 ${
                    isPlaying ? "scale-100" : "scale-[0.96] opacity-90"
                  }`}
                >
                  {currentSong.cover_art ? (
                    <img
                      src={currentSong.cover_art}
                      alt={currentSong.title}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full flex flex-col items-center justify-center text-brand-muted">
                      <Music className="w-24 h-24 opacity-30 text-brand-white animate-pulse" />
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center text-center text-brand-muted">
              <div className="p-6 rounded-full bg-brand-panel/30 border border-brand-border shadow-inner">
                <Music className="w-12 h-12 text-brand-white/50" />
              </div>
            </div>
          )}
        </div>

        {/* Lyrics Drawer (Inline, splits the space) */}
        <aside
          style={{ width: isLyricsOpen ? `${lyricsWidth}px` : "0px" }}
          className={`border-l border-brand-border/20 bg-brand-dark/20 backdrop-blur-sm flex flex-col overflow-hidden shrink-0 relative ${
            isLyricsResizing ? "" : "transition-all duration-300 ease-in-out"
          } ${
            isLyricsOpen ? "opacity-100" : "opacity-0 pointer-events-none border-l-0"
          }`}
        >
          <div className="w-full h-full flex flex-col min-w-[190px] shrink-0">


            <div
              ref={lyricsContainerRef}
              onScroll={handleLyricsScroll}
              className="flex-1 overflow-y-auto px-10 py-24 scroll-smooth"
            >
              {lyrics.length === 0 ? (
                <div className="flex flex-col items-center justify-center text-center h-full text-brand-muted p-4">
                  <p className="text-xs font-semibold">No synchronized lyrics found</p>
                  <p className="text-[10px] opacity-70 mt-1 max-w-[220px] leading-normal">
                    Create a matching <code className="text-brand-white bg-brand-panel px-1 py-0.5 rounded border border-brand-border">.lrc</code> file in the folder to display lyrics.
                  </p>
                </div>
              ) : (
                <div className="flex flex-col gap-8 py-16">
                  {lyrics.map((line, i) => {
                    const isActive = i === currentLyricIndex;
                    return (
                      <div
                        key={i}
                        ref={(el) => { lyricRefs.current[i] = el; }}
                        onClick={() => handleLyricClick(line.time)}
                        className={`text-center py-1 transition-all duration-[350ms] cursor-pointer rounded-xl px-4 hover:bg-brand-panel/20 ${
                          isActive
                            ? "text-brand-white text-xl font-bold scale-[1.03] opacity-100 drop-shadow-[0_0_15px_rgba(255,255,255,0.15)]"
                            : "text-brand-muted text-sm font-medium hover:text-brand-normal opacity-[0.55]"
                        }`}
                      >
                        {line.text || "•••"}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Resize Handle */}
            {isLyricsOpen && (
              <div
                onMouseDown={(e) => {
                  e.preventDefault();
                  setIsLyricsResizing(true);
                }}
                className={`absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-brand-border-active/50 active:bg-brand-border-active transition-colors z-20 ${
                  isLyricsResizing ? "bg-brand-border-active w-[2px]" : "bg-transparent"
                }`}
              />
            )}
          </div>
        </aside>
      </div>

      {/* 3. Bottom Playback Control Bar */}
      <footer className="h-20 bg-brand-black/40 border-t border-brand-border/40 px-6 flex items-center justify-between no-drag select-none z-10 backdrop-blur-md">
        {/* Left: Active Song details */}
        <div className="w-1/4 flex items-center gap-3">
          {currentSong && (
            <>
              <div className="w-11 h-11 rounded-lg bg-brand-panel border border-brand-border overflow-hidden shrink-0 shadow-md">
                {currentSong.cover_art ? (
                  <img
                    src={currentSong.cover_art}
                    alt=""
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-brand-muted">
                    <Music className="w-5 h-5 text-brand-white" />
                  </div>
                )}
              </div>
              <div className="min-w-0">
                <p className="text-xs font-semibold text-brand-white truncate max-w-[180px]">
                  {currentSong.title}
                </p>
                <p className="text-[10px] text-brand-muted truncate max-w-[180px] mt-0.5">
                  {currentSong.artist}
                </p>
              </div>
            </>
          )}
        </div>

        {/* Center: Controls & Slider Progress */}
        <div className="flex-1 max-w-xl flex flex-col items-center gap-2">
          {/* Playback Buttons */}
          <div className="flex items-center gap-5">
            <button
              onClick={() => setIsShuffle(!isShuffle)}
              className={`p-1.5 rounded-full transition-colors cursor-pointer active:scale-95 ${
                isShuffle ? "text-brand-white hover:text-brand-normal" : "text-brand-muted hover:text-brand-normal"
              }`}
              title="Shuffle"
            >
              <Shuffle className="w-4 h-4" />
            </button>

            <button
              onClick={playPrev}
              disabled={songs.length === 0}
              className="p-1.5 text-brand-normal hover:text-brand-white transition-colors cursor-pointer active:scale-90 disabled:opacity-30"
              title="Previous"
            >
              <SkipBack className="w-4 h-4 fill-current" />
            </button>

            <button
              onClick={togglePlay}
              disabled={!currentSong}
              className="p-2.5 rounded-full bg-brand-white text-brand-black hover:scale-105 active:scale-95 transition-all cursor-pointer flex items-center justify-center disabled:opacity-40 disabled:hover:scale-100 shadow-md"
              title={isPlaying ? "Pause" : "Play"}
            >
              {isPlaying ? (
                <Pause className="w-4.5 h-4.5 fill-current text-brand-black" />
              ) : (
                <Play className="w-4.5 h-4.5 fill-current translate-x-[1px] text-brand-black" />
              )}
            </button>

            <button
              onClick={playNext}
              disabled={songs.length === 0}
              className="p-1.5 text-brand-normal hover:text-brand-white transition-colors cursor-pointer active:scale-90 disabled:opacity-30"
              title="Next"
            >
              <SkipForward className="w-4 h-4 fill-current" />
            </button>

            <button
              onClick={() => {
                if (repeatMode === "all") setRepeatMode("one");
                else if (repeatMode === "one") setRepeatMode("none");
                else setRepeatMode("all");
              }}
              className={`p-1.5 rounded-full transition-colors cursor-pointer active:scale-95 text-xs font-semibold relative ${
                repeatMode !== "none" ? "text-brand-white hover:text-brand-normal" : "text-brand-muted hover:text-brand-normal"
              }`}
              title={`Repeat: ${repeatMode}`}
            >
              <Repeat className="w-4 h-4" />
              {repeatMode === "one" && (
                <span className="absolute -bottom-0.5 -right-0.5 text-[7px] leading-none bg-brand-white text-brand-black rounded-full px-[3px] py-[0.5px] border border-brand-black">
                  1
                </span>
              )}
            </button>
          </div>

          {/* Progress Slider */}
          <div className="w-full flex items-center gap-3">
            <span className="text-[10px] text-brand-muted font-medium w-8 text-right">
              {formatTime(currentTime)}
            </span>
            <input
              type="range"
              min="0"
              max={duration || 0}
              value={currentTime}
              onChange={handleProgressChange}
              className="flex-1 h-1 bg-brand-border rounded-lg appearance-none cursor-pointer accent-brand-white hover:accent-brand-normal focus:outline-none active:h-1.5 transition-all"
            />
            <span className="text-[10px] text-brand-muted font-medium w-8">
              {formatTime(duration)}
            </span>
          </div>
        </div>

        {/* Right: Volume Controls & Toggle Buttons */}
        <div className="w-1/4 flex items-center justify-end gap-3">
          <button
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            className="p-1.5 rounded-lg text-brand-muted hover:text-brand-normal transition-colors cursor-pointer flex items-center justify-center"
            title={theme === "dark" ? "Switch to Light Mode" : "Switch to Dark Mode"}
          >
            {theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>

          <button
            onClick={() => setIsSidebarOpen(!isSidebarOpen)}
            className={`p-1.5 rounded-lg transition-colors cursor-pointer ${
              isSidebarOpen ? "text-brand-white bg-brand-panel" : "text-brand-muted hover:text-brand-normal"
            }`}
            title="Library"
          >
            <ListMusic className="w-4 h-4" />
          </button>

          <button
            onClick={() => setIsLyricsOpen(!isLyricsOpen)}
            className={`p-1.5 rounded-lg transition-colors cursor-pointer ${
              isLyricsOpen ? "text-brand-white bg-brand-panel" : "text-brand-muted hover:text-brand-normal"
            }`}
            title="Lyrics"
          >
            <FileText className="w-4 h-4" />
          </button>

          <div className="h-4 w-[1px] bg-brand-border/40 mx-1.5" />

          <button
            onClick={() => setIsMuted(!isMuted)}
            className="text-brand-normal hover:text-brand-white transition-colors cursor-pointer"
            title={isMuted ? "Unmute" : "Mute"}
          >
            {isMuted || volume === 0 ? (
              <VolumeX className="w-4 h-4 text-brand-normal" />
            ) : (
              <Volume2 className="w-4 h-4 text-brand-normal" />
            )}
          </button>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={isMuted ? 0 : volume}
            onChange={(e) => {
              setVolume(parseFloat(e.target.value));
              if (isMuted) setIsMuted(false);
            }}
            className="w-20 h-1 bg-brand-border rounded-lg appearance-none cursor-pointer accent-brand-white hover:accent-brand-normal focus:outline-none transition-all"
          />
        </div>
      </footer>

      {/* Hidden Audio Element */}
      <audio
        ref={audioRef}
        crossOrigin="anonymous"
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        onEnded={handleAudioEnded}
      />
    </div>
  );
}

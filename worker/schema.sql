-- 雨雲をためる地点（アプリのスイッチで登録される）
CREATE TABLE IF NOT EXISTS places (
  id TEXT PRIMARY KEY,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  created INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
-- 保存した雨雲タイル（気象庁 降水ナウキャストの実況、ズーム8）
CREATE TABLE IF NOT EXISTS frames (
  validtime TEXT NOT NULL,
  z INTEGER NOT NULL,
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  png BLOB,
  PRIMARY KEY (validtime, z, x, y)
);
CREATE INDEX IF NOT EXISTS frames_time ON frames (validtime);
-- 最後の保存処理の結果（動作確認用）
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT
);

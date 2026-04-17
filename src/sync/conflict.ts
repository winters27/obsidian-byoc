/**
 * Generates a sync conflict file name.
 * Format: [original-name] (sync-conflict-[timestamp])[.ext]
 * @param filepath The original file path
 * @returns The conflict file path
 */
export const generateConflictFileName = (filepath: string): string => {
  const parts = filepath.split(".");
  const now = new Date();
  
  // Create a minimal timestamp exactly as BYOC requires
  const timestamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
  
  if (parts.length > 1 && !filepath.startsWith(".")) {
    const ext = parts.pop();
    const base = parts.join(".");
    return `${base} (sync-conflict-${timestamp}).${ext}`;
  }
  return `${filepath} (sync-conflict-${timestamp})`;
};

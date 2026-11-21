// Before a UAC relaunch the intent to enable DPI must be saved in advance:
// a successful Rust relaunch terminates the current process immediately, so a write
// after invoke would never run. On cancel/error we restore the previous value.
export async function persistDpiIntentForRelaunch({
  getEnabled,
  setEnabled,
  backup,
  relaunch,
}) {
  const previous = !!getEnabled();
  setEnabled(true);
  await backup();
  try {
    const started = await relaunch();
    if (!started) {
      setEnabled(previous);
      await backup();
    }
    return started;
  } catch (error) {
    setEnabled(previous);
    await backup();
    throw error;
  }
}

// Перед UAC-relaunch намерение включить DPI должно быть сохранено заранее:
// успешный Rust relaunch завершает текущий процесс немедленно, поэтому запись
// после invoke уже не выполнится. При отмене/ошибке возвращаем прежнее значение.
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

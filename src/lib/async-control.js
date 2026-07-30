// Маленькие координаторы для async-операций, которым нельзя владеть одним
// состоянием параллельно.

// Выполняет task последовательно и гарантирует ещё один проход со свежим
// состоянием, если request() вызвали во время уже идущего прохода.
export function createLatestRunner(task) {
  let requested = false;
  let inFlight = null;

  function request() {
    requested = true;
    if (inFlight) return inFlight;

    inFlight = (async () => {
      do {
        requested = false;
        await task();
      } while (requested);
    })();
    inFlight = inFlight.finally(() => {
      inFlight = null;
      // Защита от вызова request() на границе завершения drain.
      // Возвращаем новый flight, чтобы пограничный caller не получил resolve
      // раньше, чем будет применено запрошенное им свежее состояние.
      if (requested) return request();
    });
    return inFlight;
  }

  return { request, isRunning: () => inFlight !== null };
}

// Объединяет параллельные операции в один flight. Интерактивный запрос может
// повысить уже идущий фоновый: task читает mutable request.interactive после
// своих await и показывает результат как ручной.
export function createPromotableSingleFlight(task) {
  let active = null;

  function run({ interactive = false } = {}) {
    if (active) {
      if (interactive) active.interactive = true;
      return active.promise;
    }

    const request = { interactive: !!interactive, promise: null };
    active = request;
    request.promise = Promise.resolve()
      .then(() => task(request))
      .finally(() => {
        if (active === request) active = null;
      });
    return request.promise;
  }

  return { run, isRunning: () => active !== null };
}

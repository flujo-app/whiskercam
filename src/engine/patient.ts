/**
 * Downloads that do not give up at the first hiccup.
 *
 * The game fetches several hundred files when it starts. On mobile data, and on a host that answers
 * "busy, try later" when too many requests arrive at once, one of them failing now and then is normal.
 * A second try a moment later nearly always works; without it the estate would be short of a wall.
 */

/**
 * Run `job`; when it fails, wait and run it again: after 0.4 s, 1.2 s and 3.6 s by default.
 * A failure marked `final` is not tried again.
 */
export async function patient<T>(job: () => Promise<T>, tries = 4, firstWait = 400): Promise<T> {
  let wait = firstWait;
  for (let attempt = 1; ; attempt++) {
    try {
      return await job();
    } catch (err) {
      if (attempt >= tries || (err as { final?: boolean }).final) throw err;
      await new Promise((done) => setTimeout(done, wait));
      wait *= 3;
    }
  }
}

/**
 * `fetch` that treats "busy" as a failure and tries again. A file that is not there (404) will not turn up
 * a second later: that fails at once.
 */
export function get(url: string, tries = 4): Promise<Response> {
  return patient(async () => {
    const res = await fetch(url);
    if (!res.ok) throw Object.assign(new Error(`${res.status} ${url}`), { final: res.status === 404 });
    return res;
  }, tries);
}

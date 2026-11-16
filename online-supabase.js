const SUPABASE_JS_URL = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.1/+esm";
let clientPromise;

export async function getOnlineClient() {
  if (!clientPromise) clientPromise = initialize();
  return clientPromise;
}

async function initialize() {
  const config = window.NIGHTFALL_SUPABASE_CONFIG;
  if (!config?.url || !config?.publishableKey) throw new Error("Supabase is not configured.");
  const { createClient } = await import(SUPABASE_JS_URL);
  const supabase = createClient(new URL(config.url).origin, config.publishableKey.trim(), {
    auth: { autoRefreshToken: true, persistSession: true, detectSessionInUrl: false },
    realtime: { params: { eventsPerSecond: 12 } }
  });
  let { data, error } = await supabase.auth.getSession();
  if (error) throw new Error(`Could not load Supabase session: ${error.message}`);
  if (!data.session) {
    const signed = await supabase.auth.signInAnonymously();
    if (signed.error) throw new Error(`Guest sign-in failed: ${signed.error.message}. Enable anonymous sign-ins in Supabase Auth.`);
    data = { session: signed.data.session };
  }
  const userId = data.session.user.id;
  async function invoke(action, payload = {}) {
    const { data, error } = await supabase.functions.invoke("online", { body: { action, ...payload } });
    if (error) {
      let detail = null;
      if (error.context instanceof Response) {
        try { detail = await error.context.clone().json(); } catch {}
      }
      const failure = new Error(detail?.message || error.message || "Online game request failed.");
      failure.code = detail?.code || "ONLINE_REQUEST_FAILED";
      throw failure;
    }
    if (!data || typeof data !== "object") throw new Error("Supabase returned an invalid online game response.");
    return data;
  }
  return {
    userId,
    create: payload => invoke("create", payload),
    join: payload => invoke("join", payload),
    snapshot: roomId => invoke("snapshot", { roomId }),
    move: payload => invoke("move", payload),
    resign: roomId => invoke("resign", { roomId }),
    async subscribe(roomId, onChange, onStatus = () => {}) {
      const channel = supabase.channel(`online:${roomId}`, {
        config: { private: false }
      });
      channel.on("broadcast", { event: "state" }, message => onChange(message.payload))
        .on("broadcast", { event: "joined" }, message => onChange(message.payload));
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timed out connecting to the online game.")), 15000);
        channel.subscribe((status, err) => {
          onStatus(status, err);
          if (status === "SUBSCRIBED") {
            clearTimeout(timeout);
            resolve();
          } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
            clearTimeout(timeout);
            reject(err || new Error(`Realtime channel status: ${status}`));
          }
        });
      }).catch(async err => {
        await supabase.removeChannel(channel);
        throw err;
      });
      return {
        broadcast: async room => {
          const payload = { version: Number(room?.version) || 0, room };
          const result = await channel.send({ type: "broadcast", event: "state", payload });
          if (result !== "ok") throw new Error(`Realtime broadcast failed: ${result}`);
        },
        unsubscribe: () => supabase.removeChannel(channel)
      };
    }
  };
}

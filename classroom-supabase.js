const SUPABASE_JS_URL = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.1/+esm";
let clientPromise;

export async function getClassroomClient() {
  if (!clientPromise) clientPromise = initialize();
  return clientPromise;
}

async function initialize() {
  const config = window.NIGHTFALL_SUPABASE_CONFIG;
  if (!config || typeof config.url !== "string" || typeof config.publishableKey !== "string"
    || !config.url.trim() || !config.publishableKey.trim()) {
    throw new Error("Classroom needs a Supabase project URL and public publishable key in supabase-config.js.");
  }
  const projectUrl = new URL(config.url);
  const isLoopback = ["localhost", "127.0.0.1", "[::1]"].includes(projectUrl.hostname);
  if ((!isLoopback && projectUrl.protocol !== "https:")
    || (isLoopback && !["http:", "https:"].includes(projectUrl.protocol))) {
    throw new Error("Set the HTTPS URL of your Supabase project in supabase-config.js.");
  }

  const { createClient } = await import(SUPABASE_JS_URL);
  const supabase = createClient(projectUrl.origin, config.publishableKey.trim(), {
    auth: { autoRefreshToken: true, persistSession: true, detectSessionInUrl: false },
    realtime: { params: { eventsPerSecond: 10 } }
  });
  let { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) throw new Error(`Supabase session could not be loaded: ${sessionError.message}`);
  if (!sessionData.session) {
    const result = await supabase.auth.signInAnonymously();
    if (result.error) {
      throw new Error(`Anonymous sign-in failed: ${result.error.message}. Enable anonymous sign-ins in Supabase Auth.`);
    }
    sessionData = { session: result.data.session };
  }
  if (!sessionData.session?.user) throw new Error("Supabase did not provide an authenticated guest session.");

  return {
    userId: sessionData.session.user.id,
    async invoke(action, payload = {}) {
      const { data, error } = await supabase.functions.invoke("classroom", { body: { action, ...payload } });
      if (error) {
        let detail;
        if (error.context instanceof Response) {
          try {
            detail = await error.context.clone().json();
          } catch {
            detail = null;
          }
        }
        const failure = new Error(
          typeof detail?.message === "string" ? detail.message : error.message || "Supabase Classroom request failed."
        );
        failure.code = typeof detail?.code === "string" ? detail.code : "CLASSROOM_REQUEST_FAILED";
        throw failure;
      }
      if (!data || typeof data !== "object") throw new Error("Supabase returned an invalid Classroom response.");
      return data;
    },
    async subscribe(roomId, handlers) {
      const channel = supabase.channel(`classroom:${roomId}`, {
        config: { private: true, presence: { key: sessionData.session.user.id } }
      });
      channel
        .on("broadcast", { event: "state" }, message => handlers.event({ type: "state", payload: message.payload }))
        .on("broadcast", { event: "chat" }, message => handlers.event({ type: "chat", payload: message.payload }))
        .on("broadcast", { event: "members" }, message => handlers.event({ type: "members", payload: message.payload }))
        .on("broadcast", { event: "removed" }, message => handlers.event({ type: "removed", payload: message.payload }))
        .on("broadcast", { event: "closed" }, message => handlers.event({ type: "closed", payload: message.payload }))
        .on("presence", { event: "sync" }, () => handlers.presence(channel.presenceState()));

      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timed out connecting to the private Classroom channel.")), 15000);
        channel.subscribe(async (status, error) => {
          handlers.status(status, error);
          if (status === "SUBSCRIBED") {
            clearTimeout(timeout);
            try {
              const trackResult = await channel.track({ userId: sessionData.session.user.id });
              if (trackResult !== "ok") throw new Error(`Presence tracking returned ${trackResult}.`);
              resolve();
            } catch (trackError) {
              reject(trackError);
            }
          } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
            clearTimeout(timeout);
            reject(error || new Error(`Private Classroom channel status: ${status}`));
          }
        });
      }).catch(async error => {
        await supabase.removeChannel(channel);
        throw error;
      });

      return {
        async unsubscribe() {
          await channel.untrack();
          await supabase.removeChannel(channel);
        }
      };
    }
  };
}

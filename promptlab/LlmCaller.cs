using System;
using System.Diagnostics;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace RimSynapse.PromptLab
{
    public class LlmCallResult
    {
        public bool ok;
        public string content;
        public string error;
        public long latencyMs;
    }

    /// <summary>
    /// Sends a composed system+user pair to an OpenAI-compatible <c>/v1/chat/completions</c> endpoint with a
    /// plain <see cref="HttpClient"/> — deliberately NOT Core's SynapseClient/HttpEngine (RimWorld-coupled).
    /// The request BODY mirrors what Core's non-agentic prompt path sends: just <c>{model, messages}</c>, plus
    /// the thinking-disable flags when the config asks for them. That path passes no temperature/max_tokens/
    /// response_format, so neither does the lab (a temperature override is available for deliberate experiments).
    /// </summary>
    public static class LlmCaller
    {
        private static readonly HttpClient Http = new HttpClient();

        public static async Task<LlmCallResult> CallAsync(EffectiveEndpoint ep, ComposedPrompt prompt, int timeoutSeconds)
        {
            var sw = Stopwatch.StartNew();
            try
            {
                string url = BuildChatUrl(ep.baseUrl);
                var body = new JObject
                {
                    ["model"] = ep.model,
                    ["messages"] = new JArray
                    {
                        new JObject { ["role"] = "system", ["content"] = prompt.system },
                        new JObject { ["role"] = "user",   ["content"] = prompt.user }
                    }
                };
                if (ep.temperature.HasValue) body["temperature"] = ep.temperature.Value;
                if (ep.disableThinking)
                {
                    body["thinking"] = false;
                    body["think"] = false;
                    body["chat_template_kwargs"] = new JObject { ["enable_thinking"] = false };
                }

                using (var req = new HttpRequestMessage(HttpMethod.Post, url))
                {
                    req.Content = new StringContent(body.ToString(Formatting.None), Encoding.UTF8, "application/json");
                    if (!string.IsNullOrEmpty(ep.apiKey))
                        req.Headers.TryAddWithoutValidation("Authorization", "Bearer " + ep.apiKey);

                    using (var cts = new System.Threading.CancellationTokenSource(TimeSpan.FromSeconds(Math.Max(1, timeoutSeconds))))
                    using (var resp = await Http.SendAsync(req, cts.Token).ConfigureAwait(false))
                    {
                        string respBody = await resp.Content.ReadAsStringAsync().ConfigureAwait(false);
                        sw.Stop();
                        if (!resp.IsSuccessStatusCode)
                            return new LlmCallResult { ok = false, latencyMs = sw.ElapsedMilliseconds, error = $"HTTP {(int)resp.StatusCode}: {Trunc(respBody, 400)}" };

                        string content = ExtractContent(respBody);
                        if (content == null)
                            return new LlmCallResult { ok = false, latencyMs = sw.ElapsedMilliseconds, error = $"no choices[0].message.content in response: {Trunc(respBody, 400)}" };

                        return new LlmCallResult { ok = true, content = content, latencyMs = sw.ElapsedMilliseconds };
                    }
                }
            }
            catch (Exception ex)
            {
                sw.Stop();
                return new LlmCallResult { ok = false, latencyMs = sw.ElapsedMilliseconds, error = ex.GetType().Name + ": " + ex.Message };
            }
        }

        /// <summary>Ask the server which model is loaded (GET <c>{base}/v1/models</c>), mirroring Core's
        /// autoMapModel: a local endpoint ignores a placeholder id and the game discovers the real one.</summary>
        public static async Task<string> DiscoverModelAsync(string baseUrl, string apiKey, int timeoutSeconds)
        {
            try
            {
                string b = (baseUrl ?? "").TrimEnd('/');
                if (b.EndsWith("/v1") || b.EndsWith("/v1beta/openai") || b.EndsWith("/v1/messages"))
                    b = b.Replace("/v1/messages", "/v1");
                else
                    b += "/v1";
                string url = b + "/models";

                using (var req = new HttpRequestMessage(HttpMethod.Get, url))
                {
                    if (!string.IsNullOrEmpty(apiKey))
                        req.Headers.TryAddWithoutValidation("Authorization", "Bearer " + apiKey);
                    using (var cts = new System.Threading.CancellationTokenSource(TimeSpan.FromSeconds(Math.Max(1, timeoutSeconds))))
                    using (var resp = await Http.SendAsync(req, cts.Token).ConfigureAwait(false))
                    {
                        if (!resp.IsSuccessStatusCode) return null;
                        string body = await resp.Content.ReadAsStringAsync().ConfigureAwait(false);
                        var arr = JObject.Parse(body)["data"] as JArray;
                        var id = arr?.FirstOrDefault()?["id"];
                        return id != null ? (string)id : null;
                    }
                }
            }
            catch { return null; }
        }

        internal static string BuildChatUrl(string baseUrl)
        {
            string b = (baseUrl ?? "").TrimEnd('/');
            if (b.EndsWith("/v1") || b.EndsWith("/v1beta/openai") || b.EndsWith("/v1/messages"))
                return b.Replace("/v1/messages", "/v1") + "/chat/completions";
            return b + "/v1/chat/completions";
        }

        private static string ExtractContent(string respBody)
        {
            try
            {
                var o = JObject.Parse(respBody);
                return (string)o["choices"]?[0]?["message"]?["content"];
            }
            catch { return null; }
        }

        private static string Trunc(string s, int max)
        {
            if (string.IsNullOrEmpty(s)) return "(empty)";
            s = s.Replace("\n", " ").Replace("\r", " ");
            return s.Length <= max ? s : s.Substring(0, max) + "…";
        }
    }
}

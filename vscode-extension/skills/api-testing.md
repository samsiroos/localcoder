# REST API testing and downloads

- Use `http_request` to test HTTP APIs with GET, POST, PUT, PATCH, PUSH, or DELETE. Prefer PATCH for standard partial updates; use PUSH only when the target API explicitly implements that non-standard method.
- Inspect project documentation, OpenAPI files, environment configuration, and examples before guessing endpoints, headers, authentication, or request bodies.
- Supply headers as an object and JSON bodies as either an object or valid JSON text. Never invent credentials or expose authorization values in the final response.
- GET requests are read-only. POST, PUT, PATCH, PUSH, and DELETE require user confirmation because they can change remote data.
- Report the curl exit code, HTTP status, relevant response headers, and response body. Do not claim success based only on curl exit code; evaluate the HTTP status and API response.
- Responses are limited to 100 KB. Use `download_file` for binary or large content.
- `download_file` follows redirects, fails on HTTP errors, requires confirmation, and saves only inside the open workspace. Use a specific relative destination path and report its verified byte size.

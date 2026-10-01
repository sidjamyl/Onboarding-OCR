import { adminProxy } from "@/lib/admin-proxy";
type Context = { params: Promise<{ path: string[] }> };
async function forward(request: Request, context: Context) {
  return adminProxy(request, `/admin/${(await context.params).path.map(encodeURIComponent).join("/")}`);
}
export const GET = forward;
export const POST = forward;
export const PUT = forward;
export const DELETE = forward;

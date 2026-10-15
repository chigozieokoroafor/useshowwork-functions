declare module 'next/server' {
  export class NextResponse {
    static json(body: any, init?: { status?: number; statusText?: string; headers?: any }): any;
    static redirect(url: string | URL, status?: number): any;
  }
  export class NextRequest {
    url: string;
    headers: any;
    method: string;
  }
  export function after(callback: () => void | Promise<void>): void;
}

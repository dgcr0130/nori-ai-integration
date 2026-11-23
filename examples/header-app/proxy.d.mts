import type { Server } from 'node:http'
export function startProxy(backendUrl: string, token: string, port: number): Promise<Server>

/* eslint-disable @typescript-eslint/no-explicit-any */
import { FastifyRequest as _FastifyRequest } from 'fastify'

declare module 'fastify' {
  export interface FastifyRequest {
    userContext: UserContext
  }
}

export interface UserContext {
  userId: string | null
  role: 'admin' | 'manager' | 'user' | 'public'
  company?: string
  professionalId?: string
}

// Dichiarazione delle variabili globali iniettate da Volcanic Backend e TypeORM
declare global {
  var log: any
  var server: any
  var config: any
  var roles: any
  var connection: any
  var entity: any
  var repository: any
}

export {}

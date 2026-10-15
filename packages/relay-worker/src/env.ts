import type { RoomObject } from "./room.js";

export interface Env {
  ROOMS: DurableObjectNamespace<RoomObject>;
}

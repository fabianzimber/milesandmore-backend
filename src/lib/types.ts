// ===== Flight Types =====

export type FlightStatus = 'boarding' | 'in_flight' | 'completed' | 'cancelled' | 'aborted';

export interface Flight {
  id: number;
  channel_name: string;
  icao_from: string;
  icao_to: string;
  start_time: number;
  end_time: number;
  status: FlightStatus;
  pilot: string;
  simbrief_ofp_id?: string;
  aircraft_icao?: string;
  aircraft_name?: string;
  flight_number?: string;
  route?: string;
  cruise_altitude?: number;
  distance_nm?: number;
  estimated_time_enroute?: number;
  dep_name?: string;
  arr_name?: string;
  dep_gate?: string;
  arr_gate?: string;
  aircraft_total_seats: number;
  seat_config: string;
  current_lat?: number;
  current_lon?: number;
  current_alt?: number;
  current_speed?: number;
  current_heading?: number;
  boarding_hash?: string;
  warning_at?: number;
  close_at?: number;
  warning_job_id?: string | null;
  close_job_id?: string | null;
  lifecycle_version?: number;
  created_at?: number;
  dep_country?: string;
  arr_country?: string;
  arr_country_name?: string;
}

export interface Participant {
  id: number;
  flight_id: number;
  user_id: string;
  user_name: string;
  seat?: string;
  participant_hash: string;
  joined_at: number;
  miles_earned: number;
  boarding_pass_data?: BoardingPassData;
}

export interface BoardingPassData {
  passenger_name: string;
  flight_number: string;
  seat: string;
  gate: string;
  departure: string;
  arrival: string;
  dep_code: string;
  arr_code: string;
  date: string;
  boarding_time: string;
  aircraft: string;
}

// ===== Seat Map Types =====

export interface SeatConfig {
  layout: number[]; // e.g. [3, 3] for 3-3, [2, 4, 2] for 2-4-2
  rows: number;
  totalSeats: number;
  letters: string[]; // e.g. ['A','B','C','D','E','F']
}

export interface SeatInfo {
  id: string; // e.g. "1A"
  row: number;
  letter: string;
  occupied: boolean;
  occupant?: string; // twitch username
  isOwn: boolean;
}

// ===== SimBrief Types =====

export interface SimBriefFlightPlan {
  ofp_id: string;
  flight_number: string;
  aircraft: {
    icao: string;
    name: string;
  };
  origin: {
    icao: string;
    name: string;
    gate?: string;
    country?: string;
  };
  destination: {
    icao: string;
    name: string;
    gate?: string;
    country?: string;
    country_name?: string;
  };
  route: string;
  cruise_altitude: number;
  distance_nm: number;
  estimated_time_enroute: number;
  total_seats?: number;
  seat_config?: string;
}

// ===== User Stats =====

export interface UserMiles {
  user_id: string;
  user_name: string;
  total_miles: number;
  total_flights: number;
}

export interface UserCountry {
  country_code: string;
  country_name: string;
  unlocked_at: string;
}

// ===== Admin Types =====

export interface BotLogEntry {
  id: number;
  level: string;
  message: string;
  timestamp: string;
}

export interface ManagedChannel {
  id: number | string;
  channel_name: string;
  channel_id?: string;
  added_at: string;
  active: boolean;
}

export interface ChannelRecord {
  name: string;
  user_id: string;
  banned: number;
}

export interface BotStatus {
  uptime: number;
  channels: number;
  commandsExecuted: number;
  activeFlights?: number;
  lastEventAt?: number | null;
}

export interface BotRuntimeSettings {
  appClientId: string;
  botClientId: string;
  tokenPreview: string;
  source: "env" | "redis";
  botUserId?: string;
  botUsername?: string;
  botDisplayName?: string;
  scopes?: string[];
  updatedAt?: number | null;
  restartedAt?: number | null;
  credentialsValid: boolean;
  requiredScopesOk: boolean;
  refreshConfigured: boolean;
  issues?: string[];
}

export interface TwitchChatMessage {
  messageID: string;
  channelName: string;
  channelID: string;
  senderUsername: string;
  senderUserID: string;
  displayName: string;
  messageText: string;
  badges: Array<{ name: string; version: string }>;
}

export interface ScheduledFlightJob {
  flightId: number;
  channelName: string;
  action: "boarding-warning" | "boarding-close";
  warningMinutes?: number;
  lifecycleVersion?: number;
}

export interface SimLinkIngestPayload {
  lat?: number;
  lon?: number;
  latitude?: number;
  longitude?: number;
  alt?: number;
  altitude?: number;
  speed?: number;
  ground_speed?: number;
  groundSpeed?: number;
  heading?: number;
  hdg?: number;
  on_ground?: boolean;
  onGround?: boolean;
}


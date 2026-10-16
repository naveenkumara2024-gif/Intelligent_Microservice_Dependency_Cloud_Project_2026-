import { Aggregate } from '../aggregate';

export interface WriteResult {
  nodes: number;
  edges: number;
}

export interface GraphWriter {
  write(batch: Aggregate): Promise<WriteResult>;
  close?(): Promise<void>;
}

import { extname } from 'path';

export function getFileSuffix(fsPath: string): string {
	return extname(fsPath.toLowerCase());
}

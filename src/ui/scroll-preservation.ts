export interface ScrollPositionTarget {
	scrollTop: number;
	scrollLeft: number;
}

export function preserveScrollPosition(target: ScrollPositionTarget, update: () => void): void {
	const {scrollTop, scrollLeft} = target;
	try {
		update();
	} finally {
		target.scrollTop = scrollTop;
		target.scrollLeft = scrollLeft;
	}
}

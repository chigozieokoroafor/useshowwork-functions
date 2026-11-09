const DAYS: Record<number, number[]> = { 1: [3], 2: [2, 5], 3: [1, 3, 5], 4: [1, 3, 5, 7], 5: [1, 2, 3, 4, 5], 6: [1, 2, 3, 4, 5, 6], 7: [1, 2, 3, 4, 5, 6, 7] };

/** Preserve established Monday-based publishing days; partial weeks contain only selected days. */
export function contentSlots(start: string, end: string, frequency: number): string[] {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
        throw Error("Choose valid calendar dates.");
    }
    const first = new Date(`${start}T00:00:00.000Z`);
    const last = new Date(`${end}T00:00:00.000Z`);
    if (!Number.isFinite(first.getTime()) || !Number.isFinite(last.getTime())) {
        throw Error("Choose valid calendar dates.");
    }
    if (first.getTime() > last.getTime() || !Number.isInteger(frequency) || frequency < 1 || frequency > 14) {
        throw Error("Choose a valid range and an integer frequency from 1 to 14.");
    }
    if ((last.getTime() - first.getTime()) / 86400000 > 366) {
        throw Error("Choose a range of at most one year.");
    }
    const dates: string[] = [];
    const curr = new Date(first.getTime());
    while (curr.getTime() <= last.getTime()) {
        const dayOfWeek = curr.getUTCDay() === 0 ? 7 : curr.getUTCDay();
        if ((DAYS[Math.min(frequency, 7)] || []).includes(dayOfWeek)) {
            dates.push(curr.toISOString().slice(0, 10));
        }
        if (frequency > 7 && dayOfWeek <= frequency - 7) {
            dates.push(curr.toISOString().slice(0, 10));
        }
        curr.setUTCDate(curr.getUTCDate() + 1);
    }
    return dates;
}

export function contentStreams(platforms: string[], strategy = "SAME_CONTENT", groups: string[][] = []) {
    if (!platforms.length || new Set(platforms).size !== platforms.length)
        throw Error("Select each platform only once.");
    if (strategy === "SAME_CONTENT")
        return [{ id: "ALL", platforms }];
    if (strategy === "DIFFERENT_CONTENT")
        return platforms.map(platform => ({ id: platform, platforms: [platform] }));
    if (strategy !== "CUSTOM_GROUPS")
        throw Error("Choose a valid sharing strategy.");
    const flat = groups.flat();
    if (!groups.length || groups.some(g => !g.length) || flat.length !== platforms.length || new Set(flat).size !== flat.length || flat.some(p => !platforms.includes(p)))
        throw Error("Every selected platform must belong to exactly one content group.");
    return groups.map((platforms, i) => ({ id: `GROUP_${i + 1}`, platforms }));
}

export function generationCount(start: string, end: string, frequency: number, platforms: string[], strategy?: string, groups?: string[][]) {
    const slots = contentSlots(start, end, frequency), streams = contentStreams(platforms, strategy, groups);
    return { slots, streams, ideas: slots.length * streams.length, drafts: slots.length * platforms.length };
}

export function scheduledContentDate(day: string, time = "09:00", timeZone = "UTC", ordinal = 0) {
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time) || !Number.isInteger(ordinal) || ordinal < 0 || ordinal > 1)
        throw Error("Choose a valid publishing time.");
    const [h, m] = time.split(":").map(Number);
    const hour = ordinal ? (h === 23 ? 22 : h + 1) : h;
    const iso = `${day}T${String(hour).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;
    const date = new Date(iso);
    if (!Number.isFinite(date.getTime())) throw Error("Invalid scheduled date.");
    return date;
}


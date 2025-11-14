// --- scheduler_worker.js ---

// --- HELPER FUNCTIONS (needed by the solver) ---
function shuffleArray(array) {
    // Fisher-Yates shuffle
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

// Optional: Yield function for worker thread responsiveness (less critical than main thread)
function yieldWorker() {
    // Using setTimeout is one way, but in a worker, just letting the event loop
    // process other potential messages might be enough.
    // For very long computations within a loop, this can prevent freezing.
    return new Promise(resolve => setTimeout(resolve, 0));
}

// --- ASYNC OPTIMIZATION SOLVER (Modified for Worker) ---
async function solveFullSearchInWorker(allFaculty, allLectureSlots, teacherAvailabilityMap, facultyPreferredSlots, initialBestScore) {

    const schedule = new Map();
    const assignedLectureSlots = new Set();
    const facultyTimeSlotMap = new Map();

    let progressState = {
        facultyIndex: 0,
        combinations: 0,
        bestScore: initialBestScore // Use the score from the heuristic
    };

    const lectureSlotsByTime = new Map();
    for (const lecture of allLectureSlots) {
        if (!lectureSlotsByTime.has(lecture.timeSlot)) lectureSlotsByTime.set(lecture.timeSlot, []);
        lectureSlotsByTime.get(lecture.timeSlot).push(lecture);
    }
    // facultyPreferredSlots already passed in

    // --- Recursive helper ---
    async function solveForFaculty(facultyIndex, currentUnhappy) {
        // --- Pruning ---
        if (currentUnhappy >= progressState.bestScore) return;

        progressState.facultyIndex = facultyIndex;

        // --- Base Case: Found a better solution ---
        if (facultyIndex === allFaculty.length) {
            progressState.bestScore = currentUnhappy;
            // Send the *new best schedule* back to the main thread
            self.postMessage({
                type: 'solutionUpdate',
                schedule: Array.from(schedule.entries()), // Convert Map for transfer
                score: currentUnhappy
            });
            return;
        }

        const faculty = allFaculty[facultyIndex];

        // --- Post progress update periodically ---
        // Post more frequently for better UI feedback, e.g., every 1000 combos
        if (progressState.combinations % 1000 === 0) {
            self.postMessage({
                type: 'progressUpdate',
                facultyIndex: facultyIndex,
                facultyName: faculty,
                combinations: progressState.combinations
            });
            await yieldWorker(); // Allow worker to potentially receive messages/terminate
        }

        // --- Resume logic ---
        const assignedTimes = facultyTimeSlotMap.get(faculty) || new Set();
        const preferredSlots = facultyPreferredSlots.get(faculty) || new Set();
        const possible = [];
        for (const l of allLectureSlots) {
            if (!assignedLectureSlots.has(l.id) && !assignedTimes.has(l.timeSlot)) {
                const isHappy = preferredSlots.has(l.timeSlot);
                possible.push({ lecture: l, isHappy: isHappy });
            }
        }
        possible.sort((a, b) => b.isHappy - a.isHappy); // Prioritize happy placements

        for (const { lecture, isHappy } of possible) {
            progressState.combinations++;
            const newUnhappy = currentUnhappy + (isHappy ? 0 : 1);

            schedule.set(faculty, { lecture: lecture, isHappy: isHappy });
            assignedLectureSlots.add(lecture.id);
            assignedTimes.add(lecture.timeSlot);
            facultyTimeSlotMap.set(faculty, assignedTimes);

            await solveForFaculty(facultyIndex + 1, newUnhappy);

            // Backtrack
            schedule.delete(faculty);
            assignedLectureSlots.delete(lecture.id);
            assignedTimes.delete(lecture.timeSlot);
        }
    }

    const shuffledFaculty = shuffleArray([...allFaculty]); // Shuffle order for optimization
    await solveForFaculty(0, 0); // Start the search

    // --- Send final completion message ---
    return {
        finalCombinations: progressState.combinations,
        finalScore: progressState.bestScore
    };
}


// --- Worker Message Listener ---
self.onmessage = async (event) => {
    console.log("Worker received data");
    const { allFaculty, allLectureSlots, teacherAvailabilityMap, facultyPreferredSlots, initialBestScore } = event.data;

    try {
        // Reconstruct Maps correctly
        const reconstructedTeacherAvailabilityMap = new Map(teacherAvailabilityMap);
        const reconstructedFacultyPreferredSlots = new Map(facultyPreferredSlots.map(([k, v]) => [k, new Set(v)]));

        // Run the optimization search
        const result = await solveFullSearchInWorker(
            allFaculty,
            allLectureSlots,
            reconstructedTeacherAvailabilityMap,
            reconstructedFacultyPreferredSlots,
            initialBestScore
        );

        // Send completion message
        self.postMessage({ type: 'complete', ...result });
    } catch (error) {
        console.error("Error in worker:", error);
        self.postMessage({ type: 'error', message: error.message });
    }
};

console.log("Worker script loaded");

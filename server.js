const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", 
    methods: ["GET", "POST"]
  }
});

const questionsData = JSON.parse(fs.readFileSync('questions.json', 'utf8'));
const quizQuestions = questionsData['quiz1'] || [];

// In-memory state
let players = {};           // { socketId: { name, score, currentAnswer } }
let currentQuestionIndex = 0;
let quizInProgress = false;
let playerScores = {};
const MAX_POINTS = 1000; // Points for instant answer
const MIN_POINTS = 100;  // Minimum points for correct answer
let questionStartTime = null;

io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  // When a player joins, save them and notify all players
  socket.on('joinQuiz', (playerName) => {
    socket.playerName = playerName;
    io.to('master').emit('addedPlayer', playerName);
    players[socket.id] = { name: playerName, score: 0, currentAnswer: null };
    console.log(`${playerName} joined the quiz`);

    // Broadcast updated player list to all connected clients
    io.emit('addedPlayer', playerName);

    // Tell the new player if quiz is in progress
    socket.emit('quizStatus', { inProgress: quizInProgress });
  });

  socket.on('submitAnswer', (answer) => {
    if (!players[socket.id]) return;
    
    // Safety check for current question
    if (currentQuestionIndex < 0 || currentQuestionIndex > quizQuestions.length) {
        console.log('Invalid question index:', currentQuestionIndex);
        return;
    }

    const currentQuestion = quizQuestions[currentQuestionIndex];
    if (!currentQuestion) {
        console.log('No question found at index:', currentQuestionIndex);
        return;
    }

    const timeElapsed = (Date.now() - questionStartTime) / 1000;
    let isCorrect = false; 
    
    // Now we can safely check the question type
    if (currentQuestion.type === 'multiple_choice') {
        const correctAnswer = currentQuestion.answers.find(a => a.isCorrect)?.text;
        isCorrect = answer.toLowerCase() === correctAnswer.toLowerCase();
    } else {
        isCorrect = currentQuestion.correctAnswers.includes(answer.toLowerCase());
    }

    // Calculate points
    let points = 0;
    if (isCorrect) {
        points = Math.max(MIN_POINTS, 
            Math.floor(MAX_POINTS * (1 - timeElapsed/currentQuestion.timeLimit))
        );
        players[socket.id].score += points;
        console.log(`${players[socket.id].name} scored ${points} points`);
    }

    players[socket.id].currentAnswer = answer;
    io.emit('playerAnswered', players[socket.id].name);
  });

  socket.on('disconnect', () => {
    if (players[socket.id]) {
      console.log(`${players[socket.id].name} disconnected`);
      delete players[socket.id];
      io.emit('playerList', getPlayerNames());
    } else {
      console.log('A user disconnected before joining.');
    }
  });

  // New handler for quiz start button
  socket.on('startQuiz', () => {
    startQuiz();
    io.emit('quizStatus', { inProgress: true });
  });

  // Add to your existing socket handlers
  socket.on('revealNextWinner', (winnerIndex) => {
    const sortedScores = Object.entries(playerScores)
        .map(([name, score]) => ({ name, score }))
        .sort((a, b) => b.score - a.score);
    
    if (winnerIndex < sortedScores.length) {
        const winner = sortedScores[winnerIndex];
        const place = sortedScores.length - winnerIndex;
        io.emit('revealWinner', {
            name: winner.name,
            score: winner.score,
            place: place
        });
    }
  });
});

function startQuiz() {
  quizInProgress = true;
  currentQuestionIndex = 0;
  nextQuestion();
}

function nextQuestion() {
  if (currentQuestionIndex >= quizQuestions.length) {
    quizInProgress = false;
    io.emit('quizEnd', formatLeaderboard());
    return;
  }

  const question = quizQuestions[currentQuestionIndex];
  questionStartTime = Date.now();  // Set the start time when sending new question

  // Reset players' answers for the new question
  for (let pid in players) {
    players[pid].currentAnswer = null;
  }

  // Different payload for master vs players
  const masterPayload = {
    questionId: question.questionId,
    question: question.question,
    timeLimit: question.timeLimit,
    type: question.type,
    image: question.image || null,
    answers: question.type === "multiple_choice" ? question.answers : question.correctAnswers
  };

  const playerPayload = {
    type: question.type,
    timeLimit: question.timeLimit,
    answers: question.type === "multiple_choice" ? question.answers.map(a => a.text) : null,
    question: question.question,
    image: question.image || null   
  };

  io.emit('masterQuestion', masterPayload);
  io.emit('question', playerPayload);

  setTimeout(() => {
    currentQuestionIndex++;
    nextQuestion();
  }, question.timeLimit * 1000);
}

function formatLeaderboard() {
  let leaderboard = [];
  for (let pid in players) {
    leaderboard.push({ name: players[pid].name, score: players[pid].score });
  }
  leaderboard.sort((a,b) => b.score - a.score);
  return leaderboard;
}

// Returns an array of player names
function getPlayerNames() {
  return Object.values(players).map(p => p.name);
}

app.get('/start', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'start.html'));
});

app.use(express.static('public'));

server.listen(3001, () => {
  console.log('Listening on http://localhost:3001');
});

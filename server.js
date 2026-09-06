const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const mongoose = require('mongoose');
const dns = require('dns');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

dns.setServers(['8.8.8.8', '8.8.4.4']);

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_ride_sharing_key_123';
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://arman:arman420@cluster0.cwy3h3a.mongodb.net/ride-sharing?retryWrites=true&w=majority';

const app = express();
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ১. MongoDB কানেকশন
mongoose.connect(MONGO_URI)
  .then(() => console.log('MongoDB সফলভাবে কানেক্ট হয়েছে!'))
  .catch((err) => console.error('MongoDB কানেকশন এরর:', err));

// ২. Mongoose Schemas & Indexing Optimization
const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true, index: true },
  password: { type: String, required: true },
  role: { type: String, enum: ['rider', 'driver'], default: 'rider' },
  rating: { type: Number, default: 5.0 },
  totalRatings: { type: Number, default: 0 }
});

const locationSchema = new mongoose.Schema({
  driverId: { type: String, index: true },
  location: {
    type: { type: String, default: 'Point' },
    coordinates: [Number]
  },
  updatedAt: { type: Date, default: Date.now }
});
locationSchema.index({ location: '2dsphere' });

const rideSchema = new mongoose.Schema({
  riderId: { type: String, index: true },
  driverId: { type: String, index: true },
  pickupLocation: { lat: Number, lng: Number },
  destination: { lat: Number, lng: Number },
  fare: Number,
  pricingType: String,
  otp: String,
  paymentStatus: { type: String, enum: ['PENDING', 'PAID'], default: 'PENDING' },
  status: { 
    type: String, 
    enum: ['SEARCHING', 'ACCEPTED', 'REJECTED', 'ARRIVED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'], 
    default: 'SEARCHING',
    index: true
  },
  rating: Number,
  review: String,
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Location = mongoose.model('Location', locationSchema);
const Ride = mongoose.model('Ride', rideSchema);

// ৩. REST API Endpoints
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/admin.html');
});

app.post('/api/signup', async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    const existingUser = await User.findOne({ email });
    if (existingUser) return res.status(400).json({ message: 'ইমেইলটি ইতোমধ্যে ব্যবহৃত হচ্ছে' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = new User({ name, email, password: hashedPassword, role });
    await newUser.save();

    res.status(201).json({ message: 'অ্যাকাউন্ট তৈরি সফল হয়েছে', userId: newUser._id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ message: 'ইউজার পাওয়া যায়নি' });

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) return res.status(401).json({ message: 'পাসওয়ার্ড ভুল' });

    const token = jwt.sign({ userId: user._id, role: user.role, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ message: 'লগইন সফল', token, userId: user._id, role: user.role, name: user.name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ৪. ডাইনামিক ফেয়ার ও ওটিপি হেলপার
function calculateFare(pickup, destination) {
  const R = 6371;
  const dLat = (destination.lat - pickup.lat) * Math.PI / 180;
  const dLng = (destination.lng - pickup.lng) * Math.PI / 180;
  
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(pickup.lat * Math.PI / 180) * Math.cos(destination.lat * Math.PI / 180) * 
            Math.sin(dLng/2) * Math.sin(dLng/2);
            
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  const distanceKm = R * c;

  const baseFare = 50;
  const perKmRate = 25;
  let rawFare = baseFare + (distanceKm * perKmRate);

  const currentHour = new Date().getHours();
  let pricingType = 'NORMAL';
  let multiplier = 1.0;

  if (currentHour >= 22 || currentHour < 6) {
    pricingType = 'NIGHT_CHARGE (1.2x)';
    multiplier = 1.2;
  } else if ((currentHour >= 8 && currentHour < 10) || (currentHour >= 18 && currentHour < 20)) {
    pricingType = 'PEAK_HOUR (1.25x)';
    multiplier = 1.25;
  }

  const totalFare = Math.round(rawFare * multiplier);
  return { distanceKm: distanceKm.toFixed(2), totalFare, pricingType };
}

function generateOTP() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

// ৫. WebSocket কানেকশন ও স্টেট ম্যানেজমেন্ট
const activeUsers = new Map();

function broadcastToAdmin(eventData) {
  const payload = JSON.stringify(eventData);
  for (let [id, client] of activeUsers.entries()) {
    if (client.role === 'admin' && client.ws.readyState === 1) {
      client.ws.send(payload);
    }
  }
}

wss.on('connection', (ws) => {
  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);

      if (data.type === 'REGISTER') {
        if (data.role === 'admin') {
          activeUsers.set('ADMIN', { ws, role: 'admin' });
          ws.send(JSON.stringify({ status: 'SUCCESS', message: 'অ্যাডমিন ড্যাশবোর্ড কানেক্টেড' }));
          return;
        }

        try {
          const decoded = jwt.verify(data.token, JWT_SECRET);
          const { userId, role } = decoded;

          activeUsers.set(userId, { ws, role, location: null });
          ws.send(JSON.stringify({ status: 'SUCCESS', message: 'সার্ভারে কানেক্টেড', userId, role }));
          
          broadcastToAdmin({ type: 'ADMIN_EVENT', event: `ইউজার অনলাইন: ${role} (${userId})` });
        } catch (jwtErr) {
          ws.send(JSON.stringify({ status: 'ERROR', message: 'অবৈধ JWT Token!' }));
        }
      }

      if (data.type === 'UPDATE_LOCATION') {
        const { userId, lat, lng } = data;
        const user = activeUsers.get(userId);
        
        if (user && user.role === 'driver') {
          user.location = { lat, lng };

          await Location.findOneAndUpdate(
            { driverId: userId },
            { driverId: userId, location: { type: 'Point', coordinates: [lng, lat] }, updatedAt: new Date() },
            { upsert: true, returnDocument: 'after' }
          );

          const broadcastData = JSON.stringify({ type: 'DRIVER_LOCATION_STREAM', driverId: userId, location: { lat, lng } });

          for (let [id, client] of activeUsers.entries()) {
            if (client.role === 'rider' && client.ws.readyState === 1) {
              client.ws.send(broadcastData);
            }
          }
        }
      }

      if (data.type === 'RIDE_REQUEST') {
        const { riderId, pickup, destination } = data;
        const { distanceKm, totalFare, pricingType } = calculateFare(pickup, destination);
        const generatedOtp = generateOTP();

        const newRide = new Ride({
          riderId,
          pickupLocation: pickup,
          destination,
          fare: totalFare,
          pricingType,
          otp: generatedOtp,
          status: 'SEARCHING'
        });

        await newRide.save();

        ws.send(JSON.stringify({
          type: 'RIDE_CREATED',
          rideId: newRide._id,
          distance: `${distanceKm} km`,
          fare: totalFare,
          pricingType,
          otp: generatedOtp,
          status: 'SEARCHING'
        }));

        broadcastToAdmin({ 
          type: 'ADMIN_EVENT', 
          event: `নতুন রাইড রিকোয়েস্ট! ID: ${newRide._id}, ভাড়া: ${totalFare} টাকা (${pricingType})` 
        });
      }

      if (data.type === 'VERIFY_OTP') {
        const { rideId, otpInput } = data;
        const ride = await Ride.findById(rideId);

        if (!ride) {
          return ws.send(JSON.stringify({ status: 'ERROR', message: 'রাইড পাওয়া যায়নি!' }));
        }

        if (ride.otp === otpInput) {
          ride.status = 'IN_PROGRESS';
          await ride.save();

          const startPayload = JSON.stringify({
            type: 'TRIP_STARTED',
            rideId: ride._id,
            status: 'IN_PROGRESS',
            message: 'OTP সঠিক হয়েছে! ট্রিপ শুরু হলো।'
          });

          ws.send(startPayload);
          broadcastToAdmin({ type: 'ADMIN_EVENT', event: `ট্রিপ শুরু হয়েছে! Ride ID: ${ride._id}` });
        } else {
          ws.send(JSON.stringify({ status: 'ERROR', message: 'ভুল OTP!' }));
        }
      }

      if (data.type === 'CANCEL_RIDE') {
        const { rideId, cancelledBy, reason } = data;
        const ride = await Ride.findByIdAndUpdate(rideId, { status: 'CANCELLED' }, { returnDocument: 'after' });

        const cancelPayload = JSON.stringify({
          type: 'RIDE_CANCELLED',
          rideId: ride._id,
          cancelledBy,
          reason: reason || 'কারণ জানা যায়নি'
        });

        ws.send(cancelPayload);
        broadcastToAdmin({ type: 'ADMIN_EVENT', event: `রাইড বাতিল করা হয়েছে! Ride ID: ${ride._id}` });
      }

      if (data.type === 'UPDATE_TRIP_STATUS') {
        const { rideId, status } = data;
        const updateData = { status };
        if (status === 'COMPLETED') updateData.paymentStatus = 'PAID';

        const ride = await Ride.findByIdAndUpdate(rideId, updateData, { returnDocument: 'after' });

        const tripUpdatePayload = JSON.stringify({
          type: 'TRIP_STATUS_UPDATED',
          rideId: ride._id,
          status: ride.status,
          paymentStatus: ride.paymentStatus,
          fare: ride.fare
        });

        ws.send(tripUpdatePayload);
        broadcastToAdmin({ type: 'ADMIN_EVENT', event: `ট্রিপ স্ট্যাটাস আপডেট: ${status} (Ride ID: ${ride._id})` });
      }

    } catch (err) {
      console.error('মেসেজ প্রসেসিং এরর:', err.message);
    }
  });

  ws.on('close', () => {
    for (let [userId, user] of activeUsers.entries()) {
      if (user.ws === ws) {
        activeUsers.delete(userId);
        break;
      }
    }
  });
});

// ৬. Uncaught Error Handler
process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', (err) => console.error('Unhandled Rejection:', err));

server.listen(PORT, () => console.log(`সার্ভার চলছে: http://localhost:${PORT}`));